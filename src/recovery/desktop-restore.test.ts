import { describe, expect, it } from "vitest";
import type { DesktopBackupFileOps } from "../backup/desktop-runtime";
import { sha256 } from "../utils/hash";
import { materializeRecoveryJournalEntry } from "./desktop-restore";
import type { RecoveryJournalEntry } from "./types";

class MemoryDesktopOps implements DesktopBackupFileOps {
	readonly separator = "/";
	readonly directories = new Set<string>(["/", "/vault", "/backup", "/restore"]);
	readonly files = new Map<string, string | ArrayBuffer>();
	readonly realpaths = new Map<string, string>();

	isAbsolute(path: string): boolean { return path.startsWith("/"); }
	resolve(path: string): string { return normalize(path); }
	join(...parts: string[]): string { return normalize(parts.join("/")); }
	dirname(path: string): string {
		const normalized = normalize(path);
		const index = normalized.lastIndexOf("/");
		return index <= 0 ? "/" : normalized.slice(0, index);
	}
	relative(from: string, to: string): string {
		const left = segments(normalize(from));
		const right = segments(normalize(to));
		let shared = 0;
		while (shared < left.length && left[shared] === right[shared]) shared++;
		return [...left.slice(shared).map(() => ".."), ...right.slice(shared)].join("/");
	}
	realpath(path: string): Promise<string> {
		return Promise.resolve(this.realpaths.get(normalize(path)) ?? normalize(path));
	}
	isDirectory(path: string): Promise<boolean> { return Promise.resolve(this.directories.has(normalize(path))); }
	ensureDirectory(path: string): Promise<void> {
		let current = "";
		for (const part of segments(normalize(path))) {
			current += `/${part}`;
			this.directories.add(current);
		}
		return Promise.resolve();
	}
	exists(path: string): Promise<boolean> {
		path = normalize(path);
		return Promise.resolve(this.directories.has(path) || this.files.has(path));
	}
	readBinary(path: string): Promise<ArrayBuffer> {
		const value = this.files.get(normalize(path));
		if (value === undefined) return Promise.reject(new Error("missing"));
		return Promise.resolve(typeof value === "string"
			? new TextEncoder().encode(value).buffer
			: value.slice(0));
	}
	readText(path: string): Promise<string> {
		const value = this.files.get(normalize(path));
		if (value === undefined) return Promise.reject(new Error("missing"));
		return Promise.resolve(typeof value === "string" ? value : new TextDecoder().decode(value));
	}
	listNames(): Promise<string[]> { return Promise.resolve([]); }
	async atomicCreate(path: string, content: string | ArrayBuffer): Promise<"created" | "exists"> {
		path = normalize(path);
		if (this.files.has(path) || this.directories.has(path)) return "exists";
		await this.ensureDirectory(this.dirname(path));
		this.files.set(path, typeof content === "string" ? content : content.slice(0));
		return "created";
	}
	remove(path: string): Promise<void> {
		this.files.delete(normalize(path));
		return Promise.resolve();
	}
}

async function entry(path = "notes/before.md", contentText = "before"): Promise<RecoveryJournalEntry> {
	const content = new TextEncoder().encode(contentText).buffer;
	return {
		id: "entry-1",
		cycleId: "cycle-1",
		actionType: "delete_local",
		path,
		sourcePath: path,
		destinationPath: path,
		capturedAt: "2026-10-01T10:00:00.000Z",
		disposition: "applied",
		appliedAt: "2026-10-01T10:00:01.000Z",
		endpoints: [{
			side: "local",
			path,
			entity: {
				path,
				isDirectory: false,
				size: content.byteLength,
				mtime: 1,
				hash: await sha256(content),
			},
			content,
		}],
	};
}

describe("Safety Journal desktop recovery", () => {
	it("exports captured bytes into a separate recovery tree without touching the vault", async () => {
		const ops = new MemoryDesktopOps();
		const result = await materializeRecoveryJournalEntry(ops, {
			entry: await entry(),
			endpointIndex: 0,
			vaultBasePath: "/vault",
			backupDirectory: "/backup",
			restoreDirectory: "/restore",
		});

		expect(result.targetDirectory).toBe("/restore/momoan-sync-recovery-entry-1");
		expect(result.restoredPath).toBe(`${result.targetDirectory}/notes/before.md`);
		expect(new TextDecoder().decode(await ops.readBinary(result.restoredPath))).toBe("before");
		expect(await ops.exists("/vault/notes/before.md")).toBe(false);
		expect(await ops.exists("/restore/.momoan-sync-recovery-entry-1.pending")).toBe(false);
	});

	it("fails closed for escaped paths, content mismatch, and protected restore locations", async () => {
		const escapedOps = new MemoryDesktopOps();
		await expect(materializeRecoveryJournalEntry(escapedOps, {
			entry: await entry("../escaped.md"),
			endpointIndex: 0,
			vaultBasePath: "/vault",
			restoreDirectory: "/restore",
		})).rejects.toThrow("escapes restore directory");

		const corrupt = await entry();
		const corruptEndpoint = corrupt.endpoints[0];
		if (!corruptEndpoint) throw new Error("Missing test endpoint");
		const corruptEntry: RecoveryJournalEntry = {
			...corrupt,
			endpoints: [{
				...corruptEndpoint,
				content: new TextEncoder().encode("changed").buffer,
			}],
		};
		await expect(materializeRecoveryJournalEntry(new MemoryDesktopOps(), {
			entry: corruptEntry,
			endpointIndex: 0,
			vaultBasePath: "/vault",
			restoreDirectory: "/restore",
		})).rejects.toThrow(/size|hash/);

		const vaultOps = new MemoryDesktopOps();
		vaultOps.directories.add("/vault/recovery");
		await expect(materializeRecoveryJournalEntry(vaultOps, {
			entry: await entry(),
			endpointIndex: 0,
			vaultBasePath: "/vault",
			restoreDirectory: "/vault/recovery",
		})).rejects.toThrow("outside the Vault");

		const backupOps = new MemoryDesktopOps();
		backupOps.directories.add("/backup/recovery");
		await expect(materializeRecoveryJournalEntry(backupOps, {
			entry: await entry(),
			endpointIndex: 0,
			vaultBasePath: "/vault",
			backupDirectory: "/backup",
			restoreDirectory: "/backup/recovery",
		})).rejects.toThrow("outside the Backup Store");
	});

	it("rejects metadata-only directory endpoints and invalid endpoint indexes", async () => {
		const base = await entry("folder");
		const directory: RecoveryJournalEntry = {
			...base,
			endpoints: [{
				side: "local",
				path: "folder",
				entity: { path: "folder", isDirectory: true, size: 0, mtime: 0, hash: "" },
			}],
		};
		await expect(materializeRecoveryJournalEntry(new MemoryDesktopOps(), {
			entry: directory,
			endpointIndex: 0,
			vaultBasePath: "/vault",
			restoreDirectory: "/restore",
		})).rejects.toThrow("does not contain file content");
		await expect(materializeRecoveryJournalEntry(new MemoryDesktopOps(), {
			entry: await entry(),
			endpointIndex: 5,
			vaultBasePath: "/vault",
			restoreDirectory: "/restore",
		})).rejects.toThrow("endpoint is unavailable");
	});
});

function normalize(path: string): string {
	const absolute = path.startsWith("/");
	const output: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") output.pop();
		else output.push(part);
	}
	return `${absolute ? "/" : ""}${output.join("/")}` || (absolute ? "/" : ".");
}

function segments(path: string): string[] {
	return path.split("/").filter(Boolean);
}
