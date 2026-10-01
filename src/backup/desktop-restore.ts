import { sha256 } from "../utils/hash";
import type { BackupStore } from "./blob-store";
import { createNodeBackupFileOps, type DesktopBackupFileOps } from "./desktop-runtime";
import type {
	BackupManifest,
	BackupManifestEntry,
	BackupRestoreResult,
	BackupRestoreSelection,
} from "./types";

export interface DesktopRestoreRequest {
	readonly store: BackupStore;
	readonly manifest: BackupManifest;
	readonly vaultBasePath: string;
	readonly backupDirectory: string;
	readonly restoreDirectory: string;
	readonly selection: BackupRestoreSelection;
}

export type DesktopRestoreMaterializer = (request: DesktopRestoreRequest) => Promise<BackupRestoreResult>;

export async function restoreBackupSnapshotToDesktop(
	request: DesktopRestoreRequest,
): Promise<BackupRestoreResult> {
	const ops = await createNodeBackupFileOps();
	return materializeBackupSnapshot(ops, request);
}

export async function materializeBackupSnapshot(
	ops: DesktopBackupFileOps,
	request: DesktopRestoreRequest,
): Promise<BackupRestoreResult> {
	const restoreBase = await validateRestoreDirectory(
		ops,
		request.vaultBasePath,
		request.backupDirectory,
		request.restoreDirectory,
	);
	const entries = selectEntries(request.manifest, request.selection);
	const targetDirectory = resolveInside(ops, restoreBase, `momoan-restore-${request.manifest.snapshotId}`);
	if (await ops.exists(targetDirectory)) {
		throw new Error(`Restore target already exists: ${targetDirectory}`);
	}
	preflightDestinations(ops, targetDirectory, entries);

	const pendingMarker = resolveInside(ops, restoreBase, `.momoan-restore-${request.manifest.snapshotId}.pending`);
	if (await ops.atomicCreate(pendingMarker, pendingMarkerContent(request.manifest)) !== "created") {
		throw new Error(`Restore pending marker already exists: ${pendingMarker}`);
	}

	await ops.ensureDirectory(targetDirectory);
	let restoredDirectories = 0;
	let restoredFiles = 0;
	for (const entry of entries.filter((candidate) => candidate.kind === "directory").sort(byPathDepthThenName)) {
		await ops.ensureDirectory(resolveInside(ops, targetDirectory, entry.path));
		restoredDirectories++;
	}
	for (const entry of entries.filter((candidate) => candidate.kind === "file").sort(byPath)) {
		const content = await readVerifiedBlob(request.store, entry);
		const destination = resolveInside(ops, targetDirectory, entry.path);
		await ops.ensureDirectory(ops.dirname(destination));
		if (await ops.atomicCreate(destination, content) !== "created") {
			throw new Error(`Restore destination already exists: ${destination}`);
		}
		restoredFiles++;
	}
	await ops.remove(pendingMarker);
	return Object.freeze({
		snapshotId: request.manifest.snapshotId,
		targetDirectory,
		restoredFiles,
		restoredDirectories,
	});
}

async function validateRestoreDirectory(
	ops: DesktopBackupFileOps,
	vaultBasePath: string,
	backupDirectory: string,
	restoreDirectory: string,
): Promise<string> {
	const configured = restoreDirectory.trim();
	if (!configured) throw new Error("Choose a restore folder first");
	if (!ops.isAbsolute(vaultBasePath)) throw new Error("Vault filesystem path is unavailable");
	if (!ops.isAbsolute(configured)) throw new Error("Restore folder must be an absolute path");
	const restoreResolved = ops.resolve(configured);
	if (!await ops.isDirectory(restoreResolved)) {
		throw new Error("Restore folder must already exist and be a directory");
	}
	const vaultReal = await ops.realpath(ops.resolve(vaultBasePath));
	const restoreReal = await ops.realpath(restoreResolved);
	if (isSameOrInside(ops, vaultReal, restoreReal)) {
		throw new Error("Restore folder must be outside the Vault");
	}
	const backupReal = await ops.realpath(ops.resolve(backupDirectory));
	if (isSameOrInside(ops, backupReal, restoreReal)) {
		throw new Error("Restore folder must be outside the Backup Store");
	}
	return restoreReal;
}

function selectEntries(
	manifest: BackupManifest,
	selection: BackupRestoreSelection,
): readonly BackupManifestEntry[] {
	if (selection.kind === "all") return manifest.entries;
	const selected = manifest.entries.filter((entry) => selection.kind === "file"
		? entry.path === selection.path && entry.kind === "file"
		: entry.path === selection.path || entry.path.startsWith(`${selection.path}/`));
	if (selection.kind === "file" && selected.length !== 1) {
		throw new Error(`Backup file is not present in snapshot: ${selection.path}`);
	}
	if (selection.kind === "folder" && !selected.some((entry) =>
		entry.path === selection.path && entry.kind === "directory")) {
		throw new Error(`Backup folder is not present in snapshot: ${selection.path}`);
	}
	return selected;
}

function preflightDestinations(
	ops: DesktopBackupFileOps,
	targetDirectory: string,
	entries: readonly BackupManifestEntry[],
): void {
	const destinations = new Map<string, BackupManifestEntry>();
	for (const entry of entries) {
		const destination = resolveInside(ops, targetDirectory, entry.path);
		const duplicate = destinations.get(destination);
		if (duplicate) {
			throw new Error(`Backup entries resolve to the same restore path: ${duplicate.path}, ${entry.path}`);
		}
		destinations.set(destination, entry);
	}
	for (const [fileDestination, entry] of destinations) {
		if (entry.kind !== "file") continue;
		for (const candidateDestination of destinations.keys()) {
			if (candidateDestination === fileDestination) continue;
			if (isSameOrInside(ops, fileDestination, candidateDestination)) {
				throw new Error(`Backup file conflicts with descendant restore path: ${entry.path}`);
			}
		}
	}
}

function resolveInside(ops: DesktopBackupFileOps, root: string, path: string): string {
	const destination = ops.resolve(ops.join(root, path));
	if (!isSameOrInside(ops, root, destination) || destination === root) {
		throw new Error(`Backup entry escapes restore directory: ${path}`);
	}
	return destination;
}

async function readVerifiedBlob(store: BackupStore, entry: BackupManifestEntry): Promise<ArrayBuffer> {
	if (!entry.contentHash) throw new Error(`Backup file is missing content hash: ${entry.path}`);
	const content = await store.getBlob(entry.contentHash);
	if (!content) throw new Error(`Backup blob is missing: ${entry.contentHash}`);
	if (await sha256(content) !== entry.contentHash) {
		throw new Error(`Backup blob is corrupt: ${entry.contentHash}`);
	}
	return content;
}

function isSameOrInside(ops: DesktopBackupFileOps, parent: string, candidate: string): boolean {
	const relative = ops.relative(parent, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${ops.separator}`) && !ops.isAbsolute(relative));
}

function pendingMarkerContent(manifest: BackupManifest): string {
	return `${JSON.stringify({ snapshotId: manifest.snapshotId, createdAt: manifest.createdAt })}\n`;
}

function byPath(left: BackupManifestEntry, right: BackupManifestEntry): number {
	return left.path.localeCompare(right.path);
}

function byPathDepthThenName(left: BackupManifestEntry, right: BackupManifestEntry): number {
	const depth = pathDepth(left.path) - pathDepth(right.path);
	return depth === 0 ? byPath(left, right) : depth;
}

function pathDepth(path: string): number {
	return path.split("/").length;
}
