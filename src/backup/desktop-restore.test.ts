import { describe, expect, it } from "vitest";
import type { BackupStore } from "./blob-store";
import { materializeBackupSnapshot } from "./desktop-restore";
import type { DesktopBackupFileOps } from "./desktop-runtime";
import { createCompleteManifest } from "./manifest";
import type { BackupManifest, PendingBackupManifest } from "./types";
import { sha256 } from "../utils/hash";

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
		if (typeof value === "string") return Promise.resolve(new TextEncoder().encode(value).buffer);
		return Promise.resolve(value.slice(0));
	}
	readText(path: string): Promise<string> {
		const value = this.files.get(normalize(path));
		if (value === undefined) return Promise.reject(new Error("missing"));
		return Promise.resolve(typeof value === "string" ? value : new TextDecoder().decode(value));
	}
	listNames(path: string): Promise<string[]> {
		const directory = normalize(path);
		const prefix = directory === "/" ? "/" : `${directory}/`;
		const names = new Set<string>();
		for (const candidate of [...this.directories, ...this.files.keys()]) {
			if (!candidate.startsWith(prefix) || candidate === directory) continue;
			const rest = candidate.slice(prefix.length);
			if (rest && !rest.includes("/")) names.add(rest);
		}
		return Promise.resolve([...names]);
	}
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

class MemoryStore implements BackupStore {
	constructor(
		private readonly manifest: BackupManifest,
		private readonly blobs: ReadonlyMap<string, ArrayBuffer>,
	) {}
	beginSnapshot(): Promise<void> { return Promise.reject(new Error("unused")); }
	hasBlob(hash: string): Promise<boolean> { return Promise.resolve(this.blobs.has(hash)); }
	putBlob(): Promise<void> { return Promise.reject(new Error("unused")); }
	getBlob(hash: string): Promise<ArrayBuffer | null> { return Promise.resolve(this.blobs.get(hash)?.slice(0) ?? null); }
	commitSnapshot(): Promise<void> { return Promise.reject(new Error("unused")); }
	getManifest(id: string): Promise<BackupManifest | null> {
		return Promise.resolve(id === this.manifest.snapshotId ? this.manifest : null);
	}
	listManifests(): Promise<BackupManifest[]> { return Promise.resolve([this.manifest]); }
}

const pending: PendingBackupManifest = {
	version: 1,
	snapshotId: "snapshot-1",
	vaultId: "vault-1",
	trigger: "manual",
	createdAt: "2026-10-01T09:00:00.000Z",
	complete: false,
};

describe("desktop snapshot restore", () => {
	it("materializes a verified snapshot into a separate restore tree without overwriting the Vault", async () => {
		const rootContent = new TextEncoder().encode("root").buffer;
		const nestedContent = new TextEncoder().encode("nested").buffer;
		const rootHash = await sha256(rootContent);
		const nestedHash = await sha256(nestedContent);
		const manifest = await createCompleteManifest(pending, [
			{ path: "folder", kind: "directory", size: 0, mtime: 1 },
			{ path: "folder/nested.md", kind: "file", size: 6, mtime: 2, contentHash: nestedHash },
			{ path: "root.md", kind: "file", size: 4, mtime: 3, contentHash: rootHash },
		]);
		const store = new MemoryStore(manifest, new Map([
			[rootHash, rootContent],
			[nestedHash, nestedContent],
		]));
		const ops = new MemoryDesktopOps();

		const result = await materializeBackupSnapshot(ops, {
			store,
			manifest,
			vaultBasePath: "/vault",
			backupDirectory: "/backup",
			restoreDirectory: "/restore",
			selection: { kind: "all" },
		});

		expect(result.targetDirectory).toBe("/restore/momoan-restore-snapshot-1");
		expect(result.restoredFiles).toBe(2);
		expect(result.restoredDirectories).toBe(1);
		expect(new TextDecoder().decode(await ops.readBinary(`${result.targetDirectory}/root.md`))).toBe("root");
		expect(new TextDecoder().decode(await ops.readBinary(`${result.targetDirectory}/folder/nested.md`))).toBe("nested");
		expect(await ops.exists("/restore/.momoan-restore-snapshot-1.pending")).toBe(false);
		expect(await ops.exists("/vault/root.md")).toBe(false);
	});

	it("supports file and folder selection while preserving original relative paths", async () => {
		const first = new TextEncoder().encode("first").buffer;
		const second = new TextEncoder().encode("second").buffer;
		const firstHash = await sha256(first);
		const secondHash = await sha256(second);
		const manifest = await createCompleteManifest(pending, [
			{ path: "folder", kind: "directory", size: 0, mtime: 1 },
			{ path: "folder/a.md", kind: "file", size: 5, mtime: 2, contentHash: firstHash },
			{ path: "other.md", kind: "file", size: 6, mtime: 3, contentHash: secondHash },
		]);
		const store = new MemoryStore(manifest, new Map([[firstHash, first], [secondHash, second]]));
		const folderOps = new MemoryDesktopOps();
		const folder = await materializeBackupSnapshot(folderOps, {
			store, manifest, vaultBasePath: "/vault", backupDirectory: "/backup", restoreDirectory: "/restore",
			selection: { kind: "folder", path: "folder" },
		});
		expect(await folderOps.exists(`${folder.targetDirectory}/folder/a.md`)).toBe(true);
		expect(await folderOps.exists(`${folder.targetDirectory}/other.md`)).toBe(false);

		const fileOps = new MemoryDesktopOps();
		const file = await materializeBackupSnapshot(fileOps, {
			store, manifest, vaultBasePath: "/vault", backupDirectory: "/backup", restoreDirectory: "/restore",
			selection: { kind: "file", path: "other.md" },
		});
		expect(await fileOps.exists(`${file.targetDirectory}/other.md`)).toBe(true);
		expect(await fileOps.exists(`${file.targetDirectory}/folder/a.md`)).toBe(false);
	});

	it("fails closed when an entry would escape the restore tree", async () => {
		const content = new TextEncoder().encode("bad").buffer;
		const hash = await sha256(content);
		const manifest = await createCompleteManifest(pending, [
			{ path: "../escaped.md", kind: "file", size: 3, mtime: 1, contentHash: hash },
		]);
		const ops = new MemoryDesktopOps();
		await expect(materializeBackupSnapshot(ops, {
			store: new MemoryStore(manifest, new Map([[hash, content]])),
			manifest,
			vaultBasePath: "/vault",
			backupDirectory: "/backup",
			restoreDirectory: "/restore",
			selection: { kind: "all" },
		})).rejects.toThrow("escapes restore directory");
		expect(await ops.exists("/restore/momoan-restore-snapshot-1")).toBe(false);
	});

	it("rejects restore locations inside the Vault or Backup Store", async () => {
		const manifest = await createCompleteManifest(pending, []);
		const store = new MemoryStore(manifest, new Map());
		const vaultOps = new MemoryDesktopOps();
		vaultOps.directories.add("/vault/restore");
		await expect(materializeBackupSnapshot(vaultOps, {
			store, manifest, vaultBasePath: "/vault", backupDirectory: "/backup", restoreDirectory: "/vault/restore",
			selection: { kind: "all" },
		})).rejects.toThrow("outside the Vault");

		const backupOps = new MemoryDesktopOps();
		backupOps.directories.add("/backup/restore");
		await expect(materializeBackupSnapshot(backupOps, {
			store, manifest, vaultBasePath: "/vault", backupDirectory: "/backup", restoreDirectory: "/backup/restore",
			selection: { kind: "all" },
		})).rejects.toThrow("outside the Backup Store");
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
