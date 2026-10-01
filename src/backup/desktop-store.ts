import type { BackupStore } from "./blob-store";
import { createNodeBackupFileOps, type DesktopBackupFileOps } from "./desktop-runtime";
import { assertCompleteBackupManifest } from "./manifest";
import type { BackupManifest, PendingBackupManifest } from "./types";

const HASH_RE = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID_RE = /^[0-9A-Za-z_-]+$/;

export class DesktopBackupStore implements BackupStore {
	constructor(
		private readonly root: string,
		private readonly ops: DesktopBackupFileOps,
	) {}

	async beginSnapshot(manifest: PendingBackupManifest): Promise<void> {
		validateSnapshotId(manifest.snapshotId);
		await this.ensureLayout();
		if (await this.ops.atomicCreate(this.pendingPath(manifest.snapshotId), serialize(manifest)) !== "created") {
			throw new Error(`Backup snapshot already exists: ${manifest.snapshotId}`);
		}
	}

	hasBlob(contentHash: string): Promise<boolean> {
		validateHash(contentHash);
		return this.ops.exists(this.blobPath(contentHash));
	}

	async putBlob(contentHash: string, content: ArrayBuffer): Promise<void> {
		validateHash(contentHash);
		await this.ensureLayout();
		await this.ops.atomicCreate(this.blobPath(contentHash), content);
	}

	async getBlob(contentHash: string): Promise<ArrayBuffer | null> {
		validateHash(contentHash);
		const path = this.blobPath(contentHash);
		return await this.ops.exists(path) ? this.ops.readBinary(path) : null;
	}

	async commitSnapshot(manifest: BackupManifest): Promise<void> {
		validateSnapshotId(manifest.snapshotId);
		await this.ensureLayout();
		const pending = this.pendingPath(manifest.snapshotId);
		if (!await this.ops.exists(pending)) {
			throw new Error(`Backup pending marker is missing: ${manifest.snapshotId}`);
		}
		if (await this.ops.atomicCreate(this.manifestPath(manifest.snapshotId), serialize(manifest)) !== "created") {
			throw new Error(`Backup manifest already exists: ${manifest.snapshotId}`);
		}
		await this.ops.remove(pending);
	}

	async getManifest(snapshotId: string): Promise<BackupManifest | null> {
		validateSnapshotId(snapshotId);
		const path = this.manifestPath(snapshotId);
		if (!await this.ops.exists(path)) return null;
		return parseManifest(await this.ops.readText(path), snapshotId);
	}

	async listManifests(): Promise<BackupManifest[]> {
		const directory = this.ops.join(this.root, "manifests");
		const names = (await this.ops.listNames(directory)).filter((name) => name.endsWith(".json")).sort();
		const manifests: BackupManifest[] = [];
		for (const name of names) {
			const snapshotId = name.slice(0, -".json".length);
			validateSnapshotId(snapshotId);
			manifests.push(parseManifest(await this.ops.readText(this.ops.join(directory, name)), snapshotId));
		}
		return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async deleteManifest(snapshotId: string): Promise<void> {
		// Validate/read before unlink: pending, malformed and unknown states are not deletions.
		if (!await this.getManifest(snapshotId)) throw new Error("Complete backup manifest is missing: " + snapshotId);
		await this.ops.remove(this.manifestPath(snapshotId));
	}

	async listBlobHashes(): Promise<string[]> {
		const directory = this.ops.join(this.root, "blobs");
		const hashes: string[] = [];
		for (const name of (await this.ops.listNames(directory)).sort()) {
			if (HASH_RE.test(name) && !await this.ops.isDirectory(this.blobPath(name))) hashes.push(name);
		}
		return hashes;
	}

	async deleteBlob(contentHash: string): Promise<void> {
		validateHash(contentHash);
		await this.ops.remove(this.blobPath(contentHash));
	}

	async hasPendingSnapshots(): Promise<boolean> {
		return (await this.ops.listNames(this.ops.join(this.root, "meta", "pending"))).length > 0;
	}

	private async ensureLayout(): Promise<void> {
		await Promise.all([
			this.ops.ensureDirectory(this.ops.join(this.root, "blobs")),
			this.ops.ensureDirectory(this.ops.join(this.root, "manifests")),
			this.ops.ensureDirectory(this.ops.join(this.root, "meta", "pending")),
		]);
	}

	private blobPath(contentHash: string): string {
		return this.ops.join(this.root, "blobs", contentHash);
	}

	private manifestPath(snapshotId: string): string {
		return this.ops.join(this.root, "manifests", `${snapshotId}.json`);
	}

	private pendingPath(snapshotId: string): string {
		return this.ops.join(this.root, "meta", "pending", `${snapshotId}.json`);
	}
}

export async function createDesktopBackupStore(
	vaultBasePath: string,
	configuredDirectory: string,
): Promise<BackupStore> {
	const ops = await createNodeBackupFileOps();
	const root = await validateExternalBackupDirectory(ops, vaultBasePath, configuredDirectory);
	return new DesktopBackupStore(root, ops);
}

export async function validateExternalBackupDirectory(
	ops: DesktopBackupFileOps,
	vaultBasePath: string,
	configuredDirectory: string,
): Promise<string> {
	const configured = configuredDirectory.trim();
	if (!configured) throw new Error("Choose a backup folder first");
	if (!ops.isAbsolute(vaultBasePath)) throw new Error("Vault filesystem path is unavailable");
	if (!ops.isAbsolute(configured)) throw new Error("Backup folder must be an absolute path");
	const vaultResolved = ops.resolve(vaultBasePath);
	const backupResolved = ops.resolve(configured);
	if (isSameOrInside(ops, vaultResolved, backupResolved)) {
		throw new Error("Backup folder must be outside the Vault");
	}
	if (!await ops.isDirectory(backupResolved)) {
		throw new Error("Backup folder must already exist and be a directory");
	}
	const [vaultReal, backupReal] = await Promise.all([
		ops.realpath(vaultResolved),
		ops.realpath(backupResolved),
	]);
	if (isSameOrInside(ops, vaultReal, backupReal)) {
		throw new Error("Backup folder resolves inside the Vault");
	}
	return backupReal;
}

function isSameOrInside(ops: DesktopBackupFileOps, parent: string, candidate: string): boolean {
	const relative = ops.relative(parent, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${ops.separator}`) && !ops.isAbsolute(relative));
}

function validateHash(contentHash: string): void {
	if (!HASH_RE.test(contentHash)) throw new Error("Invalid backup content hash");
}

function validateSnapshotId(snapshotId: string): void {
	if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new Error("Invalid backup snapshot id");
}

function serialize(value: BackupManifest | PendingBackupManifest): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function parseManifest(text: string, expectedSnapshotId: string): BackupManifest {
	const value: unknown = JSON.parse(text);
	assertCompleteBackupManifest(value);
	if (value.snapshotId !== expectedSnapshotId) throw new Error("Invalid backup manifest: " + expectedSnapshotId);
	return value;
}
