import { createNodeBackupFileOps, type DesktopBackupFileOps } from "../backup/desktop-runtime";
import { sha256 } from "../utils/hash";
import type { RecoveryJournalEntry } from "./types";

const ENTRY_ID_RE = /^[0-9A-Za-z_-]+$/;

export interface RecoveryJournalRestoreRequest {
	readonly entry: RecoveryJournalEntry;
	readonly endpointIndex: number;
	readonly vaultBasePath: string;
	readonly backupDirectory?: string;
	readonly restoreDirectory: string;
}

export interface RecoveryJournalRestoreResult {
	readonly entryId: string;
	readonly targetDirectory: string;
	readonly restoredPath: string;
	readonly side: "local" | "remote";
}

export type RecoveryJournalMaterializer =
	(request: RecoveryJournalRestoreRequest) => Promise<RecoveryJournalRestoreResult>;

export async function restoreRecoveryJournalEntryToDesktop(
	request: RecoveryJournalRestoreRequest,
): Promise<RecoveryJournalRestoreResult> {
	const ops = await createNodeBackupFileOps();
	return materializeRecoveryJournalEntry(ops, request);
}

export async function materializeRecoveryJournalEntry(
	ops: DesktopBackupFileOps,
	request: RecoveryJournalRestoreRequest,
): Promise<RecoveryJournalRestoreResult> {
	validateEntryId(request.entry.id);
	const endpoint = request.entry.endpoints[request.endpointIndex];
	if (!endpoint) throw new Error("Recovery endpoint is unavailable");
	if (endpoint.entity.isDirectory || !endpoint.content) {
		throw new Error("Recovery endpoint does not contain file content");
	}
	const content = endpoint.content.slice(0);
	if (content.byteLength !== endpoint.entity.size) {
		throw new Error("Recovery content size does not match captured metadata");
	}
	if (endpoint.entity.hash && await sha256(content) !== endpoint.entity.hash) {
		throw new Error("Recovery content hash does not match captured metadata");
	}

	const restoreBase = await validateRecoveryRestoreDirectory(
		ops,
		request.vaultBasePath,
		request.backupDirectory,
		request.restoreDirectory,
	);
	const targetDirectory = resolveInside(
		ops,
		restoreBase,
		`momoan-sync-recovery-${request.entry.id}`,
	);
	if (await ops.exists(targetDirectory)) {
		throw new Error(`Recovery target already exists: ${targetDirectory}`);
	}
	const destination = resolveInside(ops, targetDirectory, endpoint.path);
	const pendingMarker = resolveInside(
		ops,
		restoreBase,
		`.momoan-sync-recovery-${request.entry.id}.pending`,
	);
	if (await ops.atomicCreate(pendingMarker, pendingMarkerContent(request.entry, request.endpointIndex)) !== "created") {
		throw new Error(`Recovery pending marker already exists: ${pendingMarker}`);
	}

	await ops.ensureDirectory(targetDirectory);
	await ops.ensureDirectory(ops.dirname(destination));
	if (await ops.atomicCreate(destination, content) !== "created") {
		throw new Error(`Recovery destination already exists: ${destination}`);
	}
	await ops.remove(pendingMarker);
	return Object.freeze({
		entryId: request.entry.id,
		targetDirectory,
		restoredPath: destination,
		side: endpoint.side,
	});
}

async function validateRecoveryRestoreDirectory(
	ops: DesktopBackupFileOps,
	vaultBasePath: string,
	backupDirectory: string | undefined,
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
	const [vaultReal, restoreReal] = await Promise.all([
		ops.realpath(ops.resolve(vaultBasePath)),
		ops.realpath(restoreResolved),
	]);
	if (isSameOrInside(ops, vaultReal, restoreReal)) {
		throw new Error("Restore folder must be outside the Vault");
	}
	const backup = backupDirectory?.trim();
	if (backup && ops.isAbsolute(backup) && await ops.isDirectory(ops.resolve(backup))) {
		const backupReal = await ops.realpath(ops.resolve(backup));
		if (isSameOrInside(ops, backupReal, restoreReal)) {
			throw new Error("Restore folder must be outside the Backup Store");
		}
	}
	return restoreReal;
}

function resolveInside(ops: DesktopBackupFileOps, root: string, path: string): string {
	const destination = ops.resolve(ops.join(root, path));
	if (!isSameOrInside(ops, root, destination) || destination === root) {
		throw new Error(`Recovery path escapes restore directory: ${path}`);
	}
	return destination;
}

function isSameOrInside(ops: DesktopBackupFileOps, parent: string, candidate: string): boolean {
	const relative = ops.relative(parent, candidate);
	return relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${ops.separator}`) && !ops.isAbsolute(relative));
}

function validateEntryId(entryId: string): void {
	if (!ENTRY_ID_RE.test(entryId)) throw new Error("Invalid recovery entry id");
}

function pendingMarkerContent(entry: RecoveryJournalEntry, endpointIndex: number): string {
	return `${JSON.stringify({
		entryId: entry.id,
		capturedAt: entry.capturedAt,
		endpointIndex,
	})}\n`;
}
