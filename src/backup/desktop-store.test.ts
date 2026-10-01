import { describe, expect, it, vi } from "vitest";
import { DesktopBackupStore, validateExternalBackupDirectory } from "./desktop-store";
import type { DesktopBackupFileOps } from "./desktop-runtime";
import type { BackupManifest, PendingBackupManifest } from "./types";

class MemoryDesktopOps implements DesktopBackupFileOps {
	readonly separator = "/";
	readonly directories = new Set<string>(["/"]);
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
	realpath(path: string): Promise<string> { return Promise.resolve(this.realpaths.get(normalize(path)) ?? normalize(path)); }
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

const pending: PendingBackupManifest = {
	version: 1,
	snapshotId: "snapshot-1",
	vaultId: "vault-1",
	trigger: "manual",
	createdAt: "2026-10-01T07:00:00.000Z",
	complete: false,
};
const complete: BackupManifest = {
	...pending,
	complete: true,
	entries: [],
	manifestHash: "manifest-hash",
};

describe("desktop backup store", () => {
	it("rejects destinations inside the Vault, including realpath aliases", async () => {
		const ops = new MemoryDesktopOps();
		ops.directories.add("/vault");
		ops.directories.add("/outside");
		ops.directories.add("/alias");
		ops.realpaths.set("/alias", "/vault/through-link");

		await expect(validateExternalBackupDirectory(ops, "/vault", "/vault/backups"))
			.rejects.toThrow("outside the Vault");
		await expect(validateExternalBackupDirectory(ops, "/vault", "/alias"))
			.rejects.toThrow("resolves inside the Vault");
		await expect(validateExternalBackupDirectory(ops, "/vault", "/outside"))
			.resolves.toBe("/outside");
	});

	it("publishes only complete manifests and clears the pending marker after commit", async () => {
		const ops = new MemoryDesktopOps();
		const store = new DesktopBackupStore("/backup", ops);

		await store.beginSnapshot(pending);
		expect(await store.listManifests()).toEqual([]);
		await store.commitSnapshot(complete);

		expect(await store.listManifests()).toEqual([complete]);
		expect(await store.getManifest("snapshot-1")).toEqual(complete);
		expect(await ops.exists("/backup/meta/pending/snapshot-1.json")).toBe(false);
	});

	it("deletes only a complete manifest and never removes a pending marker", async () => {
		const ops = new MemoryDesktopOps();
		const store = new DesktopBackupStore("/backup", ops);
		await store.beginSnapshot(pending);
		expect(await store.hasPendingSnapshots()).toBe(true);
		await expect(store.deleteManifest(pending.snapshotId)).rejects.toThrow("Complete backup manifest is missing");
		expect(await ops.exists("/backup/meta/pending/snapshot-1.json")).toBe(true);
		await store.commitSnapshot(complete);
		expect(await store.hasPendingSnapshots()).toBe(false);
		await store.deleteManifest(complete.snapshotId);
		expect(await store.listManifests()).toEqual([]);
	});

	it("lists valid blob files only and idempotently deletes one hash without touching unrelated files", async () => {
		const ops = new MemoryDesktopOps();
		const store = new DesktopBackupStore("/backup", ops);
		const hash = "a".repeat(64);
		await store.putBlob(hash, new ArrayBuffer(1));
		ops.files.set("/backup/blobs/notes.txt", "unrelated");
		ops.files.set("/backup/blobs/" + "A".repeat(64), "unknown");
		ops.files.set("/backup/blobs/.temporary", "partial");
		ops.directories.add("/backup/blobs/" + "b".repeat(64));
		expect(await store.listBlobHashes()).toEqual([hash]);
		await store.deleteBlob(hash);
		await store.deleteBlob(hash);
		await expect(store.deleteBlob("../outside")).rejects.toThrow("Invalid backup content hash");
		await expect(store.deleteManifest("../outside")).rejects.toThrow("Invalid backup snapshot id");
		expect(await store.listBlobHashes()).toEqual([]);
		expect(ops.files.size).toBe(3);
		expect(ops.directories.has("/backup/blobs/" + "b".repeat(64))).toBe(true);
	});

	it("refuses malformed manifests instead of treating them as deletable", async () => {
		const ops = new MemoryDesktopOps();
		const store = new DesktopBackupStore("/backup", ops);
		const remove = vi.spyOn(ops, "remove");
		ops.files.set("/backup/manifests/bad.json", JSON.stringify({ ...complete, snapshotId: "bad", complete: false }));
		await expect(store.deleteManifest("bad")).rejects.toThrow("Invalid backup manifest");
		expect(remove).not.toHaveBeenCalled();
	});

	it("surfaces unlink errors and conservatively detects unknown pending files", async () => {
		const ops = new MemoryDesktopOps();
		const store = new DesktopBackupStore("/backup", ops);
		await store.beginSnapshot(pending);
		await store.commitSnapshot(complete);
		ops.files.set("/backup/meta/pending/unknown.tmp", "unknown");
		expect(await store.hasPendingSnapshots()).toBe(true);
		vi.spyOn(ops, "remove").mockRejectedValue(new Error("permission denied"));
		await expect(store.deleteManifest(complete.snapshotId)).rejects.toThrow("permission denied");
		expect(await store.getManifest(complete.snapshotId)).toEqual(complete);
	});

	it("stores content-addressed blobs idempotently", async () => {
		const ops = new MemoryDesktopOps();
		const store = new DesktopBackupStore("/backup", ops);
		const hash = "a".repeat(64);
		const first = new TextEncoder().encode("first").buffer;
		const second = new TextEncoder().encode("second").buffer;

		await store.putBlob(hash, first);
		await store.putBlob(hash, second);

		expect(new TextDecoder().decode(await store.getBlob(hash) ?? new ArrayBuffer(0))).toBe("first");
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
