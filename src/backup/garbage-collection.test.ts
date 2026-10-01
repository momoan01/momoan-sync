import { describe, expect, it } from "vitest";
import type { BackupStore } from "./blob-store";
import { applyBackupRetention, BackupRetentionError } from "./garbage-collection";
import { createCompleteManifest } from "./manifest";
import type { RetentionPolicy } from "./retention";
import type { BackupManifest } from "./types";

const now = new Date("2026-10-15T12:00:00.000Z");
const none: RetentionPolicy = { recentWindowMs: 0, recentCount: 0, dailyGenerations: 0, weeklyGenerations: 0, monthlyGenerations: 0 };
const hash = (letter: string) => letter.repeat(64);
class RetentionStore implements BackupStore {
	readonly manifests = new Map<string, BackupManifest>();
	readonly blobs = new Set<string>();
	readonly events: string[] = [];
	pending = false;
	failManifest: string | null = null;
	failBlob: string | null = null;
	onList: (() => void) | undefined;
	beginSnapshot(): Promise<void> { return Promise.reject(new Error("unused")); }
	hasBlob(value: string): Promise<boolean> { return Promise.resolve(this.blobs.has(value)); }
	putBlob(): Promise<void> { return Promise.reject(new Error("unused")); }
	getBlob(): Promise<ArrayBuffer | null> { return Promise.reject(new Error("GC must not read blobs")); }
	commitSnapshot(): Promise<void> { return Promise.reject(new Error("unused")); }
	getManifest(id: string): Promise<BackupManifest | null> { return Promise.resolve(this.manifests.get(id) ?? null); }
	listManifests(): Promise<BackupManifest[]> {
		this.events.push("list"); this.onList?.(); return Promise.resolve([...this.manifests.values()]);
	}
	deleteManifest(id: string): Promise<void> {
		this.events.push("manifest:" + id);
		if (this.failManifest === id) return Promise.reject(new Error("manifest delete failed"));
		this.manifests.delete(id); return Promise.resolve();
	}
	listBlobHashes(): Promise<string[]> { this.events.push("blobs"); return Promise.resolve([...this.blobs]); }
	deleteBlob(value: string): Promise<void> {
		this.events.push("blob:" + value);
		if (this.failBlob === value) return Promise.reject(new Error("blob delete failed"));
		this.blobs.delete(value); return Promise.resolve();
	}
	hasPendingSnapshots(): Promise<boolean> { return Promise.resolve(this.pending); }
}
async function add(store: RetentionStore, id: string, date: string, hashes: string[], vaultId = "vault") {
	const manifest = await createCompleteManifest({ version: 1, snapshotId: id, vaultId,
		trigger: "manual", createdAt: date, complete: false }, hashes.map((contentHash, index) => ({
		path: "file-" + index + ".md", kind: "file" as const, size: 1, mtime: 1, contentHash,
	})));
	store.manifests.set(id, manifest);
	for (const value of hashes) store.blobs.add(value);
	return manifest;
}

describe("manifest-first all-Vault blob garbage collection", () => {
	it("protects shared and cross-Vault blobs while removing only true orphans in order", async () => {
		const store = new RetentionStore();
		await add(store, "old", "2020-01-01T00:00:00.000Z", [hash("a"), hash("b"), hash("c")]);
		await add(store, "new", "2026-10-15T11:00:00.000Z", [hash("a")]);
		await add(store, "foreign", "2020-01-01T00:00:00.000Z", [hash("b")], "other");
		store.blobs.add(hash("d"));
		const result = await applyBackupRetention(store, "vault", now, { ...none, recentCount: 1 });
		expect(result).toEqual({ retainedSnapshots: ["foreign", "new"], deletedSnapshots: ["old"],
			deletedBlobs: [hash("c"), hash("d")], reclaimedBlobCount: 2 });
		expect(store.events).toEqual(["list", "manifest:old", "list", "blobs", "blob:" + hash("c"), "blob:" + hash("d")]);
		expect([...store.blobs].sort()).toEqual([hash("a"), hash("b")]);
	});
	it("re-observes new foreign references instead of using the initial list", async () => {
		const store = new RetentionStore();
		await add(store, "old", "2020-01-01T00:00:00.000Z", [hash("a")]);
		const other = await createCompleteManifest({ version: 1, snapshotId: "foreign", vaultId: "other", trigger: "manual",
			createdAt: "2020-01-01T00:00:00.000Z", complete: false }, [{ path: "a.md", kind: "file", size: 1, mtime: 1, contentHash: hash("a") }]);
		store.onList = () => { if (!store.manifests.has("old")) store.manifests.set("foreign", other); };
		expect((await applyBackupRetention(store, "vault", now, none)).deletedBlobs).toEqual([]);
		expect(store.blobs.has(hash("a"))).toBe(true);
	});
	it("surfaces manifest deletion failure and never enters blob GC", async () => {
		const store = new RetentionStore();
		await add(store, "a", "2020-01-01T00:00:00.000Z", [hash("a")]);
		await add(store, "b", "2020-01-01T00:00:00.000Z", [hash("b")]);
		store.failManifest = "b";
		await expect(applyBackupRetention(store, "vault", now, none)).rejects.toMatchObject({
			phase: "manifest_deletion", partialResult: { deletedSnapshots: ["a"], retainedSnapshots: ["b"], deletedBlobs: [] },
		});
		expect(store.events).toEqual(["list", "manifest:a", "manifest:b"]);
		expect([...store.blobs].sort()).toEqual([hash("a"), hash("b")]);
	});
	it("surfaces blob deletion failure with partial progress and keeps retained blobs", async () => {
		const store = new RetentionStore();
		await add(store, "foreign", "2020-01-01T00:00:00.000Z", [hash("c")], "other");
		store.blobs.add(hash("a")); store.blobs.add(hash("b"));
		store.failBlob = hash("b");
		await expect(applyBackupRetention(store, "vault", now, none)).rejects.toMatchObject({
			phase: "blob_gc", partialResult: { deletedBlobs: [hash("a")], reclaimedBlobCount: 1 },
		});
		expect([...store.blobs].sort()).toEqual([hash("b"), hash("c")]);
	});
	it("blocks all destructive work when any pending snapshot exists", async () => {
		const store = new RetentionStore();
		await add(store, "old", "2020-01-01T00:00:00.000Z", [hash("a")]);
		store.pending = true;
		await expect(applyBackupRetention(store, "vault", now, none)).rejects.toThrow("pending snapshots");
		expect(store.events).toEqual([]);
		expect(store.manifests.has("old")).toBe(true);
		expect(store.blobs.has(hash("a"))).toBe(true);
	});
	it("rechecks pending state before deleting blobs", async () => {
		const store = new RetentionStore();
		await add(store, "old", "2020-01-01T00:00:00.000Z", [hash("a")]);
		store.onList = () => { if (!store.manifests.has("old")) store.pending = true; };
		await expect(applyBackupRetention(store, "vault", now, none)).rejects.toBeInstanceOf(BackupRetentionError);
		expect(store.events).toEqual(["list", "manifest:old", "list"]);
		expect(store.blobs.has(hash("a"))).toBe(true);
	});
	it("never deletes non-hash names even if a store enumerates them", async () => {
		const store = new RetentionStore();
		for (const value of ["notes.txt", "../outside", "A".repeat(64), ".temporary", hash("a")]) store.blobs.add(value);
		expect((await applyBackupRetention(store, "vault", now, none)).deletedBlobs).toEqual([hash("a")]);
		expect(store.blobs.size).toBe(4);
	});
	it("fails closed on a corrupt foreign manifest before any deletion", async () => {
		const store = new RetentionStore();
		const valid = await add(store, "foreign", "2020-01-01T00:00:00.000Z", [hash("a")], "other");
		store.manifests.set("foreign", { ...valid, entries: [] });
		await expect(applyBackupRetention(store, "vault", now, none)).rejects.toThrow("integrity verification");
		expect(store.events).toEqual(["list"]);
		expect(store.blobs.has(hash("a"))).toBe(true);
	});
	it("does not GC when the post-deletion manifest read fails", async () => {
		const store = new RetentionStore();
		await add(store, "old", "2020-01-01T00:00:00.000Z", [hash("a")]);
		store.onList = () => { if (!store.manifests.has("old")) throw new Error("re-list failed"); };
		await expect(applyBackupRetention(store, "vault", now, none)).rejects.toMatchObject({ phase: "blob_gc" });
		expect(store.events).toEqual(["list", "manifest:old", "list"]);
	});
});
