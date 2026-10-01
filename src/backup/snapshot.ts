import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import { sha256 } from "../utils/hash";
import type { BackupStore } from "./blob-store";
import { createCompleteManifest } from "./manifest";
import type {
	BackupManifest,
	BackupManifestEntry,
	BackupSnapshotTrigger,
	PendingBackupManifest,
} from "./types";

export interface CreateBackupSnapshotRequest {
	readonly store: BackupStore;
	readonly source: IFileSystem;
	readonly vaultId: string;
	readonly trigger: BackupSnapshotTrigger;
	readonly snapshotId?: () => string;
	readonly now?: () => Date;
}

/**
 * Create one crash-safe content-addressed snapshot.
 *
 * The pending marker is durable before blob writes. A failed attempt may leave
 * pending metadata or orphan blobs, but only `commitSnapshot` publishes a
 * restorable manifest. Old plans are never replayed from this state.
 */
export async function createBackupSnapshot(request: CreateBackupSnapshotRequest): Promise<BackupManifest> {
	if (!request.vaultId) throw new Error("Backup snapshot requires a vault id");
	const pending: PendingBackupManifest = Object.freeze({
		version: 1,
		snapshotId: request.snapshotId?.() ?? crypto.randomUUID(),
		vaultId: request.vaultId,
		trigger: request.trigger,
		createdAt: (request.now?.() ?? new Date()).toISOString(),
		complete: false,
	});
	const observed = [...await request.source.list()].sort((a, b) => a.path.localeCompare(b.path));
	assertUniqueSourcePaths(observed);
	await request.store.beginSnapshot(pending);

	const entries: BackupManifestEntry[] = [];
	for (const entity of observed) {
		if (entity.isDirectory) {
			entries.push(Object.freeze({
				path: entity.path,
				kind: "directory",
				size: 0,
				mtime: entity.mtime,
			}));
			continue;
		}
		const captured = await captureStableFile(request.source, entity);
		if (!await request.store.hasBlob(captured.contentHash)) {
			await request.store.putBlob(captured.contentHash, captured.content);
		}
		entries.push(Object.freeze({
			path: captured.entity.path,
			kind: "file",
			size: captured.content.byteLength,
			mtime: captured.entity.mtime,
			contentHash: captured.contentHash,
		}));
	}

	const manifest = await createCompleteManifest(pending, entries);
	await request.store.commitSnapshot(manifest);
	return manifest;
}

interface CapturedBackupFile {
	readonly entity: FileEntity;
	readonly content: ArrayBuffer;
	readonly contentHash: string;
}

async function captureStableFile(source: IFileSystem, observed: FileEntity): Promise<CapturedBackupFile> {
	const before = await source.stat(observed.path);
	assertSameFile(before, observed, observed.path);
	const first = await source.read(observed.path);
	const after = await source.stat(observed.path);
	assertSameFile(after, before, observed.path);
	const contentHash = await sha256(first);
	assertHashEvidence(observed, contentHash);
	assertHashEvidence(before, contentHash);
	assertHashEvidence(after, contentHash);
	if (first.byteLength !== observed.size) {
		throw new Error(`Backup source bytes contradict observed size: ${observed.path}`);
	}

	const hasHashProof = !!observed.hash || !!before.hash || !!after.hash;
	if (!hasHashProof && !stableMtimeEvidence(observed, before, after)) {
		const second = await source.read(observed.path);
		const final = await source.stat(observed.path);
		assertSameFile(final, after, observed.path);
		if (!buffersEqual(first, second)) throw new Error(`Backup source changed during capture: ${observed.path}`);
		return Object.freeze({ entity: Object.freeze({ ...final }), content: second.slice(0), contentHash: await sha256(second) });
	}
	return Object.freeze({ entity: Object.freeze({ ...after }), content: first.slice(0), contentHash });
}

function assertSameFile(current: FileEntity | null, previous: FileEntity, path: string): asserts current is FileEntity {
	if (!current || current.isDirectory || previous.isDirectory || current.path !== path ||
		current.size !== previous.size || current.identityKey !== previous.identityKey) {
		throw new Error(`Backup source changed during capture: ${path}`);
	}
}

function assertHashEvidence(entity: FileEntity, contentHash: string): void {
	if (entity.hash && entity.hash !== contentHash) {
		throw new Error(`Backup source hash changed during capture: ${entity.path}`);
	}
}

function stableMtimeEvidence(observed: FileEntity, before: FileEntity, after: FileEntity): boolean {
	return observed.mtime > 0 && observed.mtime === before.mtime && before.mtime === after.mtime &&
		observed.size === before.size && before.size === after.size;
}

function assertUniqueSourcePaths(entities: readonly FileEntity[]): void {
	const paths = new Set<string>();
	for (const entity of entities) {
		if (!entity.path) throw new Error("Backup source returned an empty path");
		if (paths.has(entity.path)) throw new Error(`Backup source returned duplicate path: ${entity.path}`);
		paths.add(entity.path);
	}
}

function buffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	return a.every((value, index) => value === b[index]);
}
