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

export type BackupRestoreSelection =
	| { readonly kind: "all" }
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "folder"; readonly path: string };

export interface BackupRestoreResult {
	readonly snapshotId: string;
	readonly targetDirectory: string;
	readonly restoredFiles: number;
	readonly restoredDirectories: number;
}

export interface BackupSnapshotSummary {
	readonly snapshotId: string;
	readonly createdAt: string;
	readonly trigger: BackupSnapshotTrigger;
	readonly fileCount: number;
	readonly directoryCount: number;
	readonly totalBytes: number;
}
