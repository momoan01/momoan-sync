import { errorMessage } from "../backend-api";
import type { Logger } from "../logging/logger";
import type { AirSyncSettings } from "../settings";
import type { BackupSnapshotTrigger } from "./types";

// Browser interval delays are signed 32-bit milliseconds. Reject overflow rather
// than letting a persisted large cadence silently become a rapid timer.
export function normalizeBackupIntervalMinutes(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
		value <= Math.floor(2147483647 / 60000) ? value : 0;
}

export interface BackupLifecycleDeps {
	readonly getSettings: () => Pick<AirSyncSettings, "backupDirectory" | "backupIntervalMinutes">;
	readonly isMobile: () => boolean;
	readonly isLayoutReady: () => boolean;
	readonly createSnapshot: (trigger: BackupSnapshotTrigger) => Promise<{ readonly snapshotId: string }>;
	readonly logger: Pick<Logger, "info" | "warn">;
	readonly setInterval: (callback: () => void, milliseconds: number) => number;
	readonly clearInterval: (timer: number) => void;
}

/** Background snapshots share BackupService's guard; sync waits for their reads. */
export class BackupLifecycle {
	private startupPromise: Promise<void> | null = null;
	private pending: Promise<void> | null = null;
	private activeSyncs = 0;
	private timer: number | null = null;
	private cadence = 0;
	private directory = "";
	private stopped = false;

	constructor(private readonly deps: BackupLifecycleDeps) {}

	async withSync<T>(run: () => Promise<T>): Promise<T | undefined> {
		if (this.stopped) return undefined;
		this.activeSyncs++;
		try {
			// An early request keeps the ordinary orchestrator's layout-ready gate.
			// It must not consume the once-per-session stabilized startup trigger.
			if (this.deps.isLayoutReady()) {
				this.startupPromise ??= this.backgroundSnapshot("startup");
				await this.startupPromise;
			}
			await this.pending;
			if (!this.stopped) return await run();
			return undefined;
		} finally {
			this.activeSyncs--;
		}
	}

	configure(): void {
		const directory = this.deps.getSettings().backupDirectory.trim();
		const minutes = normalizeBackupIntervalMinutes(this.deps.getSettings().backupIntervalMinutes);
		const cadence = this.stopped || !this.deps.isLayoutReady() || !this.available() ? 0 : minutes;
		// Unrelated backend/settings saves must not postpone the user's cadence.
		if (cadence === this.cadence && directory === this.directory) return;
		if (this.timer !== null) this.deps.clearInterval(this.timer);
		this.timer = null;
		this.cadence = cadence;
		this.directory = directory;
		if (cadence > 0) this.timer = this.deps.setInterval(() => { void this.tick(); }, cadence * 60000);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== null) this.deps.clearInterval(this.timer);
		this.timer = null;
	}

	private available(): boolean {
		return !this.deps.isMobile() && !!this.deps.getSettings().backupDirectory.trim();
	}

	private async tick(): Promise<void> {
		// No queued ticks, including while a previous interval reads the vault.
		if (this.stopped || this.activeSyncs > 0 || this.pending || !this.available()) return;
		this.pending = this.backgroundSnapshot("interval");
		try { await this.pending; } finally { this.pending = null; }
	}

	private async backgroundSnapshot(trigger: "startup" | "interval"): Promise<void> {
		if (this.stopped || !this.available()) return;
		try {
			const snapshot = await this.deps.createSnapshot(trigger);
			this.deps.logger.info("Background snapshot completed", { trigger, snapshotId: snapshot.snapshotId });
		} catch (error) {
			this.deps.logger.warn("Background snapshot failed", { trigger, message: errorMessage(error) });
		}
	}
}
