import { describe, expect, it, vi } from "vitest";
import { addFile, createMockLocalFs } from "../__mocks__/sync-test-helpers";
import { verifyBackupSnapshot } from "./integrity";
import { createBackupSnapshot } from "./snapshot";
import type { BackupStore } from "./blob-store";
import type { BackupManifest, PendingBackupManifest } from "./types";

class MemoryBackupStore implements BackupStore {
	readonly blobs = new Map<string, ArrayBuffer>();
	readonly pending = new Map<string, PendingBackupManifest>();
	readonly manifests = new Map<string, BackupManifest>();
	readonly operations: string[] = [];
	failBlobWrites = false;

	beginSnapshot(manifest: PendingBackupManifest): Promise<void> {
		this.operations.push(`pending:${manifest.snapshotId}`);
		this.pending.set(manifest.snapshotId, manifest);
		return Promise.resolve();
	}

	hasBlob(contentHash: string): Promise<boolean> {
		return Promise.resolve(this.blobs.has(contentHash));
	}

	putBlob(contentHash: string, content: ArrayBuffer): Promise<void> {
		this.operations.push(`blob:${contentHash}`);
		if (this.failBlobWrites) return Promise.reject(new Error("disk full"));
		this.blobs.set(contentHash, content.slice(0));
		return Promise.resolve();
	}

	getBlob(contentHash: string): Promise<ArrayBuffer | null> {
		return Promise.resolve(this.blobs.get(contentHash)?.slice(0) ?? null);
	}

	commitSnapshot(manifest: BackupManifest): Promise<void> {
		this.operations.push(`complete:${manifest.snapshotId}`);
		if (!this.pending.has(manifest.snapshotId)) {
			return Promise.reject(new Error("missing pending snapshot"));
		}
		this.manifests.set(manifest.snapshotId, manifest);
		this.pending.delete(manifest.snapshotId);
		return Promise.resolve();
	}

	getManifest(snapshotId: string): Promise<BackupManifest | null> {
		return Promise.resolve(this.manifests.get(snapshotId) ?? null);
	}

	deleteManifest(id: string): Promise<void> { this.manifests.delete(id); return Promise.resolve(); }
	listBlobHashes(): Promise<string[]> { return Promise.resolve([...this.blobs.keys()]); }
	deleteBlob(hash: string): Promise<void> { this.blobs.delete(hash); return Promise.resolve(); }
	hasPendingSnapshots(): Promise<boolean> { return Promise.resolve(this.pending.size > 0); }

	listManifests(): Promise<BackupManifest[]> {
		return Promise.resolve([...this.manifests.values()]);
	}
}

function request(store: MemoryBackupStore, source = createMockLocalFs()) {
	return {
		store,
		source,
		vaultId: "vault-1",
		trigger: "manual" as const,
		snapshotId: () => "snapshot-1",
		now: () => new Date("2026-10-01T06:30:00.000Z"),
	};
}

describe("M5 content-addressed backup core", () => {
	it("commits one complete manifest after deduplicating identical file content", async () => {
		const store = new MemoryBackupStore();
		const source = createMockLocalFs();
		addFile(source, "a.md", "same");
		addFile(source, "folder/b.md", "same");
		await source.mkdir("empty");

		const manifest = await createBackupSnapshot(request(store, source));

		expect(manifest.complete).toBe(true);
		expect(manifest.entries.map((entry) => entry.path)).toEqual(["a.md", "empty", "folder", "folder/b.md"]);
		expect(store.blobs.size).toBe(1);
		expect(store.pending.size).toBe(0);
		expect(await store.listManifests()).toEqual([manifest]);
		expect((await verifyBackupSnapshot(store, manifest)).ok).toBe(true);
		expect(store.operations[0]).toBe("pending:snapshot-1");
		expect(store.operations.at(-1)).toBe("complete:snapshot-1");
	});

	it("never exposes a complete snapshot when blob persistence fails", async () => {
		const store = new MemoryBackupStore();
		const source = createMockLocalFs();
		addFile(source, "note.md", "content");
		store.failBlobWrites = true;

		await expect(createBackupSnapshot(request(store, source))).rejects.toThrow("disk full");

		expect(store.pending.has("snapshot-1")).toBe(true);
		expect(await store.listManifests()).toEqual([]);
	});

	it("fails closed when a source changes during capture", async () => {
		const store = new MemoryBackupStore();
		const source = createMockLocalFs();
		addFile(source, "note.md", "before");
		const originalRead = source.read.bind(source);
		let changed = false;
		source.read = vi.fn(async (path: string) => {
			const bytes = await originalRead(path);
			if (!changed) {
				changed = true;
				await source.write(path, new TextEncoder().encode("after!").buffer, 2000);
			}
			return bytes;
		});

		await expect(createBackupSnapshot(request(store, source))).rejects.toThrow(/Backup source/);
		expect(await store.listManifests()).toEqual([]);
	});

	it("detects missing and corrupt content-addressed blobs", async () => {
		const store = new MemoryBackupStore();
		const source = createMockLocalFs();
		addFile(source, "a.md", "A");
		addFile(source, "b.md", "B");
		const manifest = await createBackupSnapshot(request(store, source));
		const hashes = manifest.entries.flatMap((entry) => entry.contentHash ? [entry.contentHash] : []);
		const first = hashes[0]!;
		const second = hashes[1]!;
		store.blobs.delete(first);
		store.blobs.set(second, new TextEncoder().encode("tampered").buffer);

		const result = await verifyBackupSnapshot(store, manifest);

		expect(result.ok).toBe(false);
		expect(result.missingBlobs).toEqual([first]);
		expect(result.corruptBlobs).toEqual([second]);
	});

	it("detects manifest metadata tampering independently from blob integrity", async () => {
		const store = new MemoryBackupStore();
		const source = createMockLocalFs();
		addFile(source, "note.md", "content");
		const manifest = await createBackupSnapshot(request(store, source));
		const tampered: BackupManifest = {
			...manifest,
			entries: manifest.entries.map((entry) => entry.path === "note.md" ? { ...entry, mtime: 9999 } : entry),
		};

		const result = await verifyBackupSnapshot(store, tampered);

		expect(result.ok).toBe(false);
		expect(result.manifestHashValid).toBe(false);
		expect(result.missingBlobs).toEqual([]);
		expect(result.corruptBlobs).toEqual([]);
	});
});
