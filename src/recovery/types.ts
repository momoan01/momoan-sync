import type { FileEntity } from "../fs/types";
import type { SyncActionType, SyncRecord } from "../sync/types";

export type RecoveryDisposition = "captured" | "applied";

export interface RecoveryEndpointSnapshot {
	readonly side: "local" | "remote";
	readonly path: string;
	readonly entity: FileEntity;
	/** Exact pre-effect bytes. Directories intentionally omit content. */
	readonly content?: ArrayBuffer;
}

/**
 * Durable recovery material only. It is never an instruction to replay an action.
 * A row left in `captured` after a crash means "inspect/reobserve", not "execute".
 */
export interface RecoveryJournalEntry {
	readonly id: string;
	readonly cycleId: string;
	readonly actionType: SyncActionType;
	readonly path: string;
	readonly entityId?: string;
	readonly sourcePath: string;
	readonly destinationPath: string;
	readonly capturedAt: string;
	readonly baseline?: SyncRecord;
	readonly endpoints: readonly RecoveryEndpointSnapshot[];
	readonly disposition: RecoveryDisposition;
	readonly appliedAt?: string;
}
