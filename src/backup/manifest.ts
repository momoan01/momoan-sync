import { sha256 } from "../utils/hash";
import type { BackupManifest, BackupManifestEntry, PendingBackupManifest } from "./types";

export type HashableBackupManifest = Omit<BackupManifest, "manifestHash">;

export async function createCompleteManifest(
	pending: PendingBackupManifest,
	entries: readonly BackupManifestEntry[],
): Promise<BackupManifest> {
	assertEntries(entries);
	const normalizedEntries = Object.freeze([...entries].sort((a, b) => a.path.localeCompare(b.path)));
	const hashable: HashableBackupManifest = Object.freeze({
		version: pending.version,
		snapshotId: pending.snapshotId,
		vaultId: pending.vaultId,
		trigger: pending.trigger,
		createdAt: pending.createdAt,
		complete: true,
		entries: normalizedEntries,
	});
	return Object.freeze({ ...hashable, manifestHash: await computeManifestHash(hashable) });
}

export async function computeManifestHash(manifest: HashableBackupManifest): Promise<string> {
	assertEntries(manifest.entries);
	const payload = {
		version: manifest.version,
		snapshotId: manifest.snapshotId,
		vaultId: manifest.vaultId,
		trigger: manifest.trigger,
		createdAt: manifest.createdAt,
		complete: manifest.complete,
		entries: manifest.entries,
	};
	return sha256(new TextEncoder().encode(JSON.stringify(payload)).buffer);
}

function assertEntries(entries: readonly BackupManifestEntry[]): void {
	const paths = new Set<string>();
	for (const entry of entries) {
		if (!entry.path) throw new Error("Backup manifest entry path is required");
		if (paths.has(entry.path)) throw new Error(`Backup manifest contains duplicate path: ${entry.path}`);
		paths.add(entry.path);
		if (entry.kind === "file" && !entry.contentHash) {
			throw new Error(`Backup file entry is missing content hash: ${entry.path}`);
		}
		if (entry.kind === "directory" && entry.contentHash !== undefined) {
			throw new Error(`Backup directory entry cannot reference content: ${entry.path}`);
		}
	}
}
