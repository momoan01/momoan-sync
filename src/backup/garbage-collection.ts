import type { BackupStore } from "./blob-store";
import { assertCompleteBackupManifest, computeManifestHash, isBackupContentHash } from "./manifest";
import { planBackupRetention, type RetentionPolicy } from "./retention";
import type { BackupManifest } from "./types";

export interface BackupRetentionResult {
	readonly retainedSnapshots: readonly string[];
	readonly deletedSnapshots: readonly string[];
	readonly deletedBlobs: readonly string[];
	readonly reclaimedBlobCount: number;
}

/** Successful deletions are irreversible; an error exposes exact partial progress. */
export class BackupRetentionError extends Error {
	constructor(
		readonly phase: "manifest_deletion" | "blob_gc",
		readonly partialResult: BackupRetentionResult,
		readonly original: unknown,
	) {
		super("Backup retention failed during " + phase + ": " + (original instanceof Error ? original.message : String(original)));
		this.name = "BackupRetentionError";
	}
}

/** Caller must hold the snapshot/restore/retention single-flight guard.
 * Manifest-first is a correctness boundary: no blob is eligible until ALL planned
 * manifest deletions succeed and ALL Vaults' remaining manifests are re-read.
 * Unknown/corrupt manifests and any pending marker prevent destructive work.
 */
export async function applyBackupRetention(
	store: BackupStore,
	vaultId: string,
	referenceTime: Date,
	policy: RetentionPolicy,
): Promise<BackupRetentionResult> {
	await assertNoPending(store);
	const initial = await verifiedManifests(store);
	const plan = planBackupRetention(initial, vaultId, referenceTime, policy);
	const deletedSnapshots: string[] = [];
	const deletedBlobs: string[] = [];
	let retained = initial.map((manifest) => manifest.snapshotId);
	const result = (): BackupRetentionResult => Object.freeze({
		retainedSnapshots: Object.freeze(retained.filter((id) => !deletedSnapshots.includes(id)).sort()),
		deletedSnapshots: Object.freeze([...deletedSnapshots]),
		deletedBlobs: Object.freeze([...deletedBlobs]),
		reclaimedBlobCount: deletedBlobs.length,
	});
	try {
		await assertNoPending(store);
		for (const snapshotId of plan.deleteSnapshotIds) {
			await assertNoPending(store);
			await store.deleteManifest(snapshotId);
			deletedSnapshots.push(snapshotId);
		}
	} catch (error) {
		throw new BackupRetentionError("manifest_deletion", result(), error);
	}
	try {
		// Re-read every Vault's references after manifest deletion, never from the plan.
		const remaining = await verifiedManifests(store);
		retained = remaining.map((manifest) => manifest.snapshotId);
		const referenced = new Set(remaining.flatMap((manifest) => manifest.entries
			.filter((entry) => entry.kind === "file").map((entry) => entry.contentHash!)));
		await assertNoPending(store);
		const hashes = [...new Set(await store.listBlobHashes())].filter(isBackupContentHash).sort();
		for (const hash of hashes) {
			if (referenced.has(hash)) continue;
			await assertNoPending(store);
			await store.deleteBlob(hash);
			deletedBlobs.push(hash);
		}
	} catch (error) {
		throw new BackupRetentionError("blob_gc", result(), error);
	}
	return result();
}

async function assertNoPending(store: BackupStore): Promise<void> {
	if (await store.hasPendingSnapshots()) throw new Error("Backup retention is blocked by pending snapshots");
}

async function verifiedManifests(store: BackupStore): Promise<BackupManifest[]> {
	const manifests = await store.listManifests();
	for (const manifest of manifests) {
		assertCompleteBackupManifest(manifest);
		if (await computeManifestHash(manifest) !== manifest.manifestHash) {
			throw new Error("Backup manifest failed integrity verification: " + manifest.snapshotId);
		}
	}
	return manifests;
}
