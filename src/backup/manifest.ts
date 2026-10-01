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

/** Shared structural validation before a stored manifest can authorize deletion. */
export function assertCompleteBackupManifest(value: unknown): asserts value is BackupManifest {
	if (typeof value !== "object" || value === null) throw new Error("Invalid backup manifest");
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || record.complete !== true || typeof record.snapshotId !== "string" ||
		!/^[0-9A-Za-z_-]+$/.test(record.snapshotId) || typeof record.vaultId !== "string" || !record.vaultId.trim() ||
		typeof record.trigger !== "string" || !["manual", "startup", "interval", "mass_change_guard", "recovery_cold", "schema_migration"].includes(record.trigger) ||
		typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
		new Date(record.createdAt).toISOString() !== record.createdAt ||
		typeof record.manifestHash !== "string" || !record.manifestHash || !Array.isArray(record.entries)) {
		throw new Error("Invalid backup manifest");
	}
	const paths = new Set<string>();
	for (const value of record.entries as unknown[]) {
		if (typeof value !== "object" || value === null) throw new Error("Invalid backup manifest entry");
		const entry = value as Record<string, unknown>;
		if (typeof entry.path !== "string" || !entry.path || paths.has(entry.path) ||
			typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
			typeof entry.mtime !== "number" || !Number.isFinite(entry.mtime) ||
			(entry.kind !== "file" && entry.kind !== "directory") ||
			(entry.kind === "file" && (typeof entry.contentHash !== "string" || !isBackupContentHash(entry.contentHash))) ||
			(entry.kind === "directory" && entry.contentHash !== undefined)) {
			throw new Error("Invalid backup manifest entry");
		}
		paths.add(entry.path);
	}
}

export function isBackupContentHash(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }
