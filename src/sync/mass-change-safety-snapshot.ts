import { errorMessage } from "../backend-api";
import type { Logger } from "../logging/logger";
import type { MassChangeGuardVerdict } from "./mass-change-guard";

type GuardVerdict = Extract<MassChangeGuardVerdict, { readonly kind: "guard" }>;

export interface MassChangeSafetySnapshot {
	readonly snapshotId: string;
}

export class MassChangeSafetySnapshotError extends Error {
	readonly permanent = true;
	readonly permanentCode = "mass_change_safety_snapshot_failed";

	constructor(message: string) {
		super(message);
		this.name = "MassChangeSafetySnapshotError";
	}
}

export async function requireMassChangeSafetySnapshot(
	createSnapshot: (() => Promise<MassChangeSafetySnapshot>) | undefined,
	logger: Logger | undefined,
	verdict: GuardVerdict,
): Promise<void> {
	if (!createSnapshot) {
		throw new MassChangeSafetySnapshotError("Mass Change Guard requires a local safety snapshot");
	}
	try {
		const snapshot = await createSnapshot();
		logger?.warn("Mass Change Guard safety snapshot completed", {
			snapshotId: snapshot.snapshotId,
			...verdict.metrics,
		});
	} catch (error) {
		if (error instanceof MassChangeSafetySnapshotError) throw error;
		throw new MassChangeSafetySnapshotError(`Mass Change Guard safety snapshot failed: ${errorMessage(error)}`);
	}
}
