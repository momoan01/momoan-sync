import { describe, expect, it } from "vitest";
import { buildNotificationMessage, CycleSummary } from "./sync-notification";
import type { SyncCycleOutcome } from "./sync-notification";
import type { SyncAction } from "./types";

function concurrentRename() {
	return {
		action: "rename_local" as const, oldPath: "pc1.md", path: "drive.md",
		local: { path: "pc1.md", isDirectory: false, size: 1, mtime: 100, hash: "h" },
		remote: { path: "drive.md", isDirectory: false, size: 1, mtime: 1, hash: "h" },
		baseline: { path: "test.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "X", syncedAt: 1 },
	};
}

function outcome(admissionFailures = 0): SyncCycleOutcome {
	return {
		completion: { kind: admissionFailures > 0 ? "incomplete" : "clean" },
		execution: { succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [] },
		admissionFailures: Array.from({ length: admissionFailures }, (_, index) => ({
			kind: "failed", paths: [`path-${index}.md`], actions: [], evidence: [],
			reasons: ["rename_mismatch"],
		})),
	};
}

describe("sync notification Admission failure visibility", () => {
	it("does not present an incomplete actionless cycle as up to date", () => {
		const incomplete = { ...outcome(), completion: { kind: "incomplete" as const } };
		expect(buildNotificationMessage(incomplete)).toBe("Sync: incomplete");
		const summary = new CycleSummary();
		summary.add(incomplete);
		summary.add(outcome());
		expect(summary.message).toBe("Sync: incomplete");
	});
	it("presents rejected components as errors without a retryability claim", () => {
		expect(buildNotificationMessage(outcome(2))).toBe("Sync: 2 errors — Admission failed (unclassified)");
	});

	it("does not report a queued follow-up as an error", () => {
		// A cycle that settled a namespace contention below the boundary queues a
		// follow-up and carries no Admission failure; the follow-up converges. Neither
		// is an error of the burst.
		const followUp: SyncCycleOutcome = { ...outcome(), completion: { kind: "follow_up" } };
		const summary = new CycleSummary();
		summary.add(followUp);
		summary.add(outcome());

		expect(summary.message).toBe("Everything up to date");
	});

	it("counts every remote rename, including one at a conflict-suffixed address", () => {
		const repair = { action: "rename_remote", path: "note.conflict-id-z.md", oldPath: "note.md" } as const;
		const moved = { action: "rename_remote", path: "b.md", oldPath: "a.md" } as const;
		const cycle: SyncCycleOutcome = {
			...outcome(),
			execution: { succeeded: [{ action: repair }, { action: moved }], superseded: [], failed: [], blocked: [], conflicts: [] },
		};

		expect(buildNotificationMessage(cycle)).toBe("Sync: 2 renamed");
	});

	it("coalesces Admission failures across cycles", () => {
		const summary = new CycleSummary();
		summary.add(outcome(1));
		summary.add(outcome(2));

		expect(summary.message).toBe("Sync: 3 errors — Admission failed (unclassified)");
	});

	it("reports a successful concurrent rename with the remote name kept", () => {
		const cycle = outcome();
		cycle.execution.succeeded.push({ action: concurrentRename() });
		expect(buildNotificationMessage(cycle)).toBe("Sync: 1 renamed, 1 rename conflict (remote name kept)");
		cycle.execution.succeeded.push({ action: concurrentRename() });
		expect(buildNotificationMessage(cycle)).toBe("Sync: 2 renamed, 2 rename conflicts (remote name kept)");
	});

	it("reports the remote name kept alongside a content conflict", () => {
		const cycle = outcome();
		const action: SyncAction = { ...concurrentRename(), action: "conflict",
			protocol: { kind: "same_path" }, conflictPolicy: { mode: "preserve", strategy: "duplicate" } };
		cycle.execution.succeeded.push({ action });
		expect(buildNotificationMessage(cycle)).toBe("Sync: 1 rename conflict (remote name kept)");
	});

	it.each([
		{ baseline: undefined },
		{ local: undefined },
		{ remote: undefined },
		{ local: { path: "test.md", isDirectory: false, size: 1, mtime: 1, hash: "h" } },
		{ remote: { path: "test.md", isDirectory: false, size: 1, mtime: 1, hash: "h" } },
		{ local: { path: "drive.md", isDirectory: false, size: 1, mtime: 1, hash: "h" } },
		{ path: "other.md" },
	])("does not label an ordinary rename as a concurrent rename conflict (%j)", (override) => {
		const cycle = outcome();
		cycle.execution.succeeded.push({ action: { ...concurrentRename(), ...override } });
		expect(buildNotificationMessage(cycle)).toBe("Sync: 1 renamed");
	});

	it("does not count a superseded concurrent rename as successfully resolved", () => {
		const cycle = outcome();
		cycle.execution.superseded.push({ action: concurrentRename(), terminalRecord: concurrentRename().baseline });
		expect(buildNotificationMessage(cycle)).toBe("Sync: 1 renamed");
	});
});
