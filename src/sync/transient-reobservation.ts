import type { LocalChangeTracker, TrackerSnapshot } from "./local-tracker";
import type { SyncCycleOutcome } from "./sync-notification";

/** New local producer input supersedes a blocked push; the scheduler owns its debounce. */
export function isBenignLocalSupersession(
	outcome: SyncCycleOutcome,
	snapshot: TrackerSnapshot,
	tracker: LocalChangeTracker,
): boolean {
	if (outcome.completion.kind !== "incomplete" || !snapshot.generations ||
		outcome.admissionFailures.length > 0 || outcome.execution.failed.length > 0 ||
		outcome.execution.blocked.length === 0) return false;
	const generations = snapshot.generations;
	return outcome.execution.blocked.every(({ action, classification, localSupersession }) => {
		if (classification !== "precondition_changed" || localSupersession !== true || action.action !== "push") return false;
		const path = action.localPath ?? action.local?.path ?? action.path;
		return tracker.generation(path) > (generations.get(path) ?? 0);
	});
}
