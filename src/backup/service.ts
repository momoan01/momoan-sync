import type { BackupStore } from "./blob-store";
import { createDesktopBackupStore } from "./desktop-store";
import { createBackupSnapshot } from "./snapshot";
import type { BackupSource } from "./source";
import type { BackupManifest } from "./types";

export interface BackupServiceDeps {
	readonly source: BackupSource;
	readonly getVaultId: () => string;
	readonly getBackupDirectory: () => string;
	readonly getVaultBasePath: () => string | null;
	readonly isMobile: () => boolean;
	readonly createStore?: (vaultBasePath: string, backupDirectory: string) => Promise<BackupStore>;
}

export class BackupService {
	private running = false;

	constructor(private readonly deps: BackupServiceDeps) {}

	async backupNow(): Promise<BackupManifest> {
		if (this.running) throw new Error("Backup is already running");
		if (this.deps.isMobile()) throw new Error("Local snapshots are unavailable on mobile");
		const vaultBasePath = this.deps.getVaultBasePath();
		if (!vaultBasePath) throw new Error("Vault filesystem path is unavailable");
		const backupDirectory = this.deps.getBackupDirectory().trim();
		if (!backupDirectory) throw new Error("Choose a backup folder first");

		this.running = true;
		try {
			const createStore = this.deps.createStore ?? createDesktopBackupStore;
			const store = await createStore(vaultBasePath, backupDirectory);
			return await createBackupSnapshot({
				store,
				source: this.deps.source,
				vaultId: this.deps.getVaultId(),
				trigger: "manual",
			});
		} finally {
			this.running = false;
		}
	}
}
