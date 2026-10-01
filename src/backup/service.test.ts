import { describe, expect, it, vi } from "vitest";
import { addFile, createMockLocalFs, deferred } from "../__mocks__/sync-test-helpers";
import type { BackupStore } from "./blob-store";
import type { DesktopRestoreRequest } from "./desktop-restore";
import type { RetentionPolicy } from "./retention";
import { BackupService } from "./service";
import type { BackupManifest, PendingBackupManifest } from "./types";

class MemoryStore implements BackupStore {
	readonly blobs = new Map<string, ArrayBuffer>();
	readonly manifests: BackupManifest[] = [];
	private pending: PendingBackupManifest | null = null;
	beginSnapshot(manifest: PendingBackupManifest): Promise<void> { this.pending = manifest; return Promise.resolve(); }
	hasBlob(hash: string): Promise<boolean> { return Promise.resolve(this.blobs.has(hash)); }
	putBlob(hash: string, content: ArrayBuffer): Promise<void> { this.blobs.set(hash, content.slice(0)); return Promise.resolve(); }
	getBlob(hash: string): Promise<ArrayBuffer | null> { return Promise.resolve(this.blobs.get(hash)?.slice(0) ?? null); }
	commitSnapshot(manifest: BackupManifest): Promise<void> {
		if (!this.pending) return Promise.reject(new Error("missing pending"));
		this.pending = null;
		this.manifests.push(manifest);
		return Promise.resolve();
	}
	getManifest(id: string): Promise<BackupManifest | null> {
		return Promise.resolve(this.manifests.find((manifest) => manifest.snapshotId === id) ?? null);
	}
	deleteManifest(id: string): Promise<void> {
		const index = this.manifests.findIndex((manifest) => manifest.snapshotId === id);
		if (index >= 0) this.manifests.splice(index, 1);
		return Promise.resolve();
	}
	listBlobHashes(): Promise<string[]> { return Promise.resolve([...this.blobs.keys()]); }
	deleteBlob(hash: string): Promise<void> { this.blobs.delete(hash); return Promise.resolve(); }
	hasPendingSnapshots(): Promise<boolean> { return Promise.resolve(this.pending !== null); }
	listManifests(): Promise<BackupManifest[]> { return Promise.resolve([...this.manifests]); }
}

function createService(
	store: MemoryStore,
	overrides: Partial<ConstructorParameters<typeof BackupService>[0]> = {},
): BackupService {
	return new BackupService({
		source: createMockLocalFs(),
		getVaultId: () => "vault-1",
		getBackupDirectory: () => "/outside",
		getVaultBasePath: () => "/vault",
		isMobile: () => false,
		createStore: () => Promise.resolve(store),
		...overrides,
	});
}

describe("backup service", () => {
	it("excludes snapshot, restore and another retention while retention is running", async () => {
		const store = new MemoryStore();
		const gate = deferred<BackupManifest[]>();
		const list = vi.spyOn(store, "listManifests").mockImplementation(() => gate.promise);
		const service = createService(store);
		const policy: RetentionPolicy = { recentWindowMs: 0, recentCount: 0, dailyGenerations: 0, weeklyGenerations: 0, monthlyGenerations: 0 };
		const first = service.applyRetention(policy, new Date("2026-10-15T12:00:00.000Z"));
		await expect(service.backupNow()).rejects.toThrow("already running");
		await expect(service.restoreSnapshot("snapshot", "/restore")).rejects.toThrow("already running");
		await expect(service.applyRetention(policy, new Date())).rejects.toThrow("already running");
		gate.resolve([]);
		expect(await first).toEqual({ retainedSnapshots: [], deletedSnapshots: [], deletedBlobs: [], reclaimedBlobCount: 0 });
		list.mockRestore();
		await expect(service.backupNow()).resolves.toMatchObject({ complete: true });
	});

	it.each(["snapshot", "restore"] as const)("blocks retention while %s holds the existing running guard", async (operation) => {
		const store = new MemoryStore();
		const manifest = await createService(store).backupNow();
		const gate = deferred<BackupStore>();
		const service = createService(store, { createStore: () => gate.promise,
			restoreSnapshot: (request) => Promise.resolve({ snapshotId: request.manifest.snapshotId,
				targetDirectory: "/restore", restoredFiles: 0, restoredDirectories: 0 }) });
		const first = operation === "snapshot" ? service.backupNow() : service.restoreSnapshot(manifest.snapshotId, "/restore");
		const policy: RetentionPolicy = { recentWindowMs: 0, recentCount: 0, dailyGenerations: 0, weeklyGenerations: 0, monthlyGenerations: 0 };
		await expect(service.applyRetention(policy, new Date())).rejects.toThrow("already running");
		gate.resolve(store);
		await first;
	});

	it("releases the running guard after a pending-blocked retention failure", async () => {
		const store = new MemoryStore();
		await store.beginSnapshot({ version: 1, snapshotId: "pending", vaultId: "other", trigger: "manual",
			createdAt: "2026-10-15T12:00:00.000Z", complete: false });
		const service = createService(store);
		const policy: RetentionPolicy = { recentWindowMs: 0, recentCount: 0, dailyGenerations: 0, weeklyGenerations: 0, monthlyGenerations: 0 };
		await expect(service.applyRetention(policy, new Date())).rejects.toThrow("pending snapshots");
		await expect(service.backupNow()).resolves.toMatchObject({ complete: true });
	});

	it("creates a manual whole-Vault snapshot through the configured desktop store", async () => {
		const source = createMockLocalFs();
		addFile(source, "note.md", "hello");
		const store = new MemoryStore();
		const calls: string[][] = [];
		const service = new BackupService({
			source,
			getVaultId: () => "vault-1",
			getBackupDirectory: () => " /outside ",
			getVaultBasePath: () => "/vault",
			isMobile: () => false,
			createStore: (vault, backup) => { calls.push([vault, backup]); return Promise.resolve(store); },
		});

		const manifest = await service.backupNow();

		expect(calls).toEqual([["/vault", "/outside"]]);
		expect(manifest.trigger).toBe("manual");
		expect(manifest.entries.some((entry) => entry.path === "note.md")).toBe(true);
		expect(store.manifests).toEqual([manifest]);
	});

	it("creates a required safety snapshot with the requested trigger", async () => {
		const store = new MemoryStore();
		const source = createMockLocalFs();
		addFile(source, "note.md", "hello");
		const service = createService(store, { source });

		const manifest = await service.createSnapshot("mass_change_guard");

		expect(manifest.trigger).toBe("mass_change_guard");
		expect(store.manifests).toEqual([manifest]);
	});

	it("lists and verifies completed snapshots for the current Vault", async () => {
		const store = new MemoryStore();
		const source = createMockLocalFs();
		addFile(source, "note.md", "hello");
		const service = createService(store, { source });
		const manifest = await service.backupNow();

		const summaries = await service.listSnapshots();
		const integrity = await service.verifySnapshot(manifest.snapshotId);

		expect(summaries).toEqual([{
			snapshotId: manifest.snapshotId,
			createdAt: manifest.createdAt,
			trigger: "manual",
			fileCount: 1,
			directoryCount: 0,
			totalBytes: 5,
		}]);
		expect(integrity.ok).toBe(true);
	});

	it("restores only after integrity verification and preserves explicit selection", async () => {
		const store = new MemoryStore();
		const source = createMockLocalFs();
		addFile(source, "note.md", "hello");
		const requests: DesktopRestoreRequest[] = [];
		const service = createService(store, {
			source,
			restoreSnapshot: (value) => {
				requests.push(value);
				return Promise.resolve({
					snapshotId: value.manifest.snapshotId,
					targetDirectory: "/restore/output",
					restoredFiles: 1,
					restoredDirectories: 0,
				});
			},
		});
		const manifest = await service.backupNow();

		const result = await service.restoreSnapshot(
			manifest.snapshotId,
			"/restore",
			{ kind: "file", path: "note.md" },
		);

		expect(requests[0]?.selection).toEqual({ kind: "file", path: "note.md" });
		expect(requests[0]?.backupDirectory).toBe("/outside");
		expect(result.restoredFiles).toBe(1);
	});

	it("blocks restore when snapshot integrity no longer holds", async () => {
		const store = new MemoryStore();
		const source = createMockLocalFs();
		addFile(source, "note.md", "hello");
		const service = createService(store, {
			source,
			restoreSnapshot: () => Promise.reject(new Error("must not run")),
		});
		const manifest = await service.backupNow();
		const file = manifest.entries.find((entry) => entry.kind === "file");
		if (!file?.contentHash) throw new Error("expected backup file");
		store.blobs.set(file.contentHash, new TextEncoder().encode("tampered").buffer);

		await expect(service.restoreSnapshot(manifest.snapshotId, "/restore"))
			.rejects.toThrow("integrity verification");
	});

	it("does not expose another Vault's snapshot through recovery APIs", async () => {
		const store = new MemoryStore();
		const source = createMockLocalFs();
		addFile(source, "note.md", "hello");
		const owner = createService(store, { source });
		const manifest = await owner.backupNow();
		const otherVault = createService(store, { getVaultId: () => "vault-2" });

		expect(await otherVault.listSnapshots()).toEqual([]);
		await expect(otherVault.verifySnapshot(manifest.snapshotId)).rejects.toThrow("current Vault");
	});

	it("keeps local snapshots disabled on mobile", async () => {
		const service = new BackupService({
			source: createMockLocalFs(),
			getVaultId: () => "vault-1",
			getBackupDirectory: () => "/outside",
			getVaultBasePath: () => "/vault",
			isMobile: () => true,
			createStore: () => Promise.reject(new Error("must not run")),
		});
		await expect(service.backupNow()).rejects.toThrow("unavailable on mobile");
		await expect(service.listSnapshots()).rejects.toThrow("unavailable on mobile");
	});

	it("serializes manual backup requests instead of racing one store", async () => {
		const gate = deferred<BackupStore>();
		const service = new BackupService({
			source: createMockLocalFs(),
			getVaultId: () => "vault-1",
			getBackupDirectory: () => "/outside",
			getVaultBasePath: () => "/vault",
			isMobile: () => false,
			createStore: () => gate.promise,
		});
		const first = service.backupNow();
		await expect(service.backupNow()).rejects.toThrow("already running");
		gate.resolve(new MemoryStore());
		await first;
	});
});
