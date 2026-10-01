import type { BackupStore } from "./blob-store";
import {
	restoreBackupSnapshotToDesktop,
	type DesktopRestoreMaterializer,
} from "./desktop-restore";
import { createDesktopBackupStore } from "./desktop-store";
import { applyBackupRetention, type BackupRetentionResult } from "./garbage-collection";
import type { RetentionPolicy } from "./retention";
import { verifyBackupSnapshot } from "./integrity";
import { createBackupSnapshot } from "./snapshot";
import type { BackupSource } from "./source";
import type {
	BackupIntegrityResult,
	BackupManifest,
	BackupRestoreResult,
	BackupRestoreSelection,
	BackupSnapshotSummary,
	BackupSnapshotTrigger,
} from "./types";

export interface BackupServiceDeps {
	readonly source: BackupSource;
	readonly getVaultId: () => string;
	readonly getBackupDirectory: () => string;
	readonly getVaultBasePath: () => string | null;
	readonly isMobile: () => boolean;
	readonly createStore?: (vaultBasePath: string, backupDirectory: string) => Promise<BackupStore>;
	readonly restoreSnapshot?: DesktopRestoreMaterializer;
}

export class BackupService {
	private running = false;

	constructor(private readonly deps: BackupServiceDeps) {}

	backupNow(): Promise<BackupManifest> {
		return this.createSnapshot("manual");
	}

	async createSnapshot(trigger: BackupSnapshotTrigger): Promise<BackupManifest> {
		if (this.running) throw new Error("Backup is already running");
		this.running = true;
		try {
			const { store } = await this.openStore();
			return await createBackupSnapshot({
				store,
				source: this.deps.source,
				vaultId: this.deps.getVaultId(),
				trigger,
			});
		} finally {
			this.running = false;
		}
	}

	async applyRetention(policy: RetentionPolicy, referenceTime: Date): Promise<BackupRetentionResult> {
		if (this.running) throw new Error("Backup is already running");
		this.running = true;
		try {
			const { store } = await this.openStore();
			return await applyBackupRetention(store, this.deps.getVaultId(), referenceTime, policy);
		} finally {
			this.running = false;
		}
	}

	async listSnapshots(): Promise<readonly BackupSnapshotSummary[]> {
		const { store } = await this.openStore();
		return (await store.listManifests())
			.filter((manifest) => manifest.vaultId === this.deps.getVaultId())
			.map(toSummary);
	}

	async verifySnapshot(snapshotId: string): Promise<BackupIntegrityResult> {
		const { store } = await this.openStore();
		const manifest = await this.currentVaultManifest(store, snapshotId);
		return verifyBackupSnapshot(store, manifest);
	}

	async restoreSnapshot(
		snapshotId: string,
		restoreDirectory: string,
		selection: BackupRestoreSelection = { kind: "all" },
	): Promise<BackupRestoreResult> {
		if (this.running) throw new Error("Backup is already running");
		this.running = true;
		try {
			const { store, vaultBasePath, backupDirectory } = await this.openStore();
			const manifest = await this.currentVaultManifest(store, snapshotId);
			const integrity = await verifyBackupSnapshot(store, manifest);
			if (!integrity.ok) throw new Error("Backup snapshot failed integrity verification");
			const restore = this.deps.restoreSnapshot ?? restoreBackupSnapshotToDesktop;
			return await restore({
				store,
				manifest,
				vaultBasePath,
				backupDirectory,
				restoreDirectory,
				selection,
			});
		} finally {
			this.running = false;
		}
	}

	private async openStore(): Promise<{
		readonly store: BackupStore;
		readonly vaultBasePath: string;
		readonly backupDirectory: string;
	}> {
		if (this.deps.isMobile()) throw new Error("Local snapshots are unavailable on mobile");
		const vaultBasePath = this.deps.getVaultBasePath();
		if (!vaultBasePath) throw new Error("Vault filesystem path is unavailable");
		const backupDirectory = this.deps.getBackupDirectory().trim();
		if (!backupDirectory) throw new Error("Choose a backup folder first");
		const createStore = this.deps.createStore ?? createDesktopBackupStore;
		return { store: await createStore(vaultBasePath, backupDirectory), vaultBasePath, backupDirectory };
	}

	private async currentVaultManifest(store: BackupStore, snapshotId: string): Promise<BackupManifest> {
		const manifest = await store.getManifest(snapshotId);
		if (!manifest || manifest.vaultId !== this.deps.getVaultId()) {
			throw new Error(`Backup snapshot is not available for the current Vault: ${snapshotId}`);
		}
		return manifest;
	}
}

function toSummary(manifest: BackupManifest): BackupSnapshotSummary {
	let fileCount = 0;
	let directoryCount = 0;
	let totalBytes = 0;
	for (const entry of manifest.entries) {
		if (entry.kind === "file") {
			fileCount++;
			totalBytes += entry.size;
		} else {
			directoryCount++;
		}
	}
	return Object.freeze({
		snapshotId: manifest.snapshotId,
		createdAt: manifest.createdAt,
		trigger: manifest.trigger,
		fileCount,
		directoryCount,
		totalBytes,
	});
}
