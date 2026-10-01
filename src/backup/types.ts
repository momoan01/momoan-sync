export type BackupSnapshotTrigger =
	| "manual"
	| "startup"
	| "interval"
	| "mass_change_guard"
	| "recovery_cold"
	| "schema_migration";

export interface PendingBackupManifest {
	readonly version: 1;
	readonly snapshotId: string;
	readonly vaultId: string;
	readonly trigger: BackupSnapshotTrigger;
	readonly createdAt: string;
	readonly complete: false;
}

export interface BackupManifestEntry {
	readonly path: string;
	readonly kind: "file" | "directory";
	readonly size: number;
	readonly mtime: number;
	readonly contentHash?: string;
}

export interface BackupManifest {
	readonly version: 1;
	readonly snapshotId: string;
	readonly vaultId: string;
	readonly trigger: BackupSnapshotTrigger;
	readonly createdAt: string;
	readonly complete: true;
	readonly entries: readonly BackupManifestEntry[];
	readonly manifestHash: string;
}

export interface BackupIntegrityResult {
	readonly ok: boolean;
	readonly manifestHashValid: boolean;
	readonly missingBlobs: readonly string[];
	readonly corruptBlobs: readonly string[];
}
