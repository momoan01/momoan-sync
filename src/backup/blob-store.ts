import type { BackupManifest, PendingBackupManifest } from "./types";

/**
 * Durable backup storage boundary. Production implementations must target a
 * location outside the Vault sync root; the Backup Engine never assumes the
 * store shares authority with Sync state.
 */
export interface BackupStore {
	/** Persist the non-restorable in-progress marker before snapshot writes begin. */
	beginSnapshot(manifest: PendingBackupManifest): Promise<void>;
	/** Content-addressed blob lookup used to deduplicate across snapshots. */
	hasBlob(contentHash: string): Promise<boolean>;
	/** Persist bytes under their SHA-256 content hash. */
	putBlob(contentHash: string, content: ArrayBuffer): Promise<void>;
	/** Read a blob for integrity verification and restore. */
	getBlob(contentHash: string): Promise<ArrayBuffer | null>;
	/** Atomically publish the complete manifest, then clear the pending marker. */
	commitSnapshot(manifest: BackupManifest): Promise<void>;
	/** Return only completed/restorable manifests. */
	getManifest(snapshotId: string): Promise<BackupManifest | null>;
	/** List only completed/restorable manifests. */
	listManifests(): Promise<BackupManifest[]>;
	/** Delete only a complete manifest. Failure must prevent subsequent blob GC. */
	deleteManifest(snapshotId: string): Promise<void>;
	/** Enumerate only valid SHA-256 blob names; unknown files are never GC targets. */
	listBlobHashes(): Promise<string[]>;
	/** Idempotently remove one validated blob hash, after reference re-observation. */
	deleteBlob(contentHash: string): Promise<void>;
	/** Any pending marker blocks retention; no stale-marker cleanup is implied. */
	hasPendingSnapshots(): Promise<boolean>;
}
