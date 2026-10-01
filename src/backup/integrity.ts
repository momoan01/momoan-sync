import { sha256 } from "../utils/hash";
import { computeManifestHash } from "./manifest";
import type { BackupStore } from "./blob-store";
import type { BackupIntegrityResult, BackupManifest } from "./types";

export async function verifyBackupSnapshot(
	store: BackupStore,
	manifest: BackupManifest,
): Promise<BackupIntegrityResult> {
	const expectedManifestHash = await computeManifestHash({
		version: manifest.version,
		snapshotId: manifest.snapshotId,
		vaultId: manifest.vaultId,
		trigger: manifest.trigger,
		createdAt: manifest.createdAt,
		complete: true,
		entries: manifest.entries,
	});
	const missing = new Set<string>();
	const corrupt = new Set<string>();
	for (const entry of manifest.entries) {
		if (entry.kind !== "file" || !entry.contentHash) continue;
		const content = await store.getBlob(entry.contentHash);
		if (!content) {
			missing.add(entry.contentHash);
			continue;
		}
		if (await sha256(content) !== entry.contentHash) corrupt.add(entry.contentHash);
	}
	const missingBlobs = Object.freeze([...missing].sort());
	const corruptBlobs = Object.freeze([...corrupt].sort());
	const manifestHashValid = expectedManifestHash === manifest.manifestHash;
	return Object.freeze({
		ok: manifestHashValid && missingBlobs.length === 0 && corruptBlobs.length === 0,
		manifestHashValid,
		missingBlobs,
		corruptBlobs,
	});
}
