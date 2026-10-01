import { describe, expect, it } from "vitest";
import type { AuthorizedSyncPlan } from "./plan-admission";
import { evaluateMassChangeGuard } from "./mass-change-guard";
import type { SyncAction } from "./types";

function plan(actions: SyncAction[]): AuthorizedSyncPlan {
	return { actions, components: [] } as unknown as AuthorizedSyncPlan;
}

function actions(kind: SyncAction["action"], count: number): SyncAction[] {
	return Array.from({ length: count }, (_, index) => ({ action: kind, path: `p-${index}` }) as SyncAction);
}

describe("M4 Mass Change Guard", () => {
	it("allows ordinary small plans", () => {
		const verdict = evaluateMassChangeGuard(plan(actions("delete_remote", 2)), 100);
		expect(verdict.kind).toBe("allow");
	});

	it("guards a high destructive ratio", () => {
		const verdict = evaluateMassChangeGuard(plan(actions("delete_local", 5)), 10);
		expect(verdict.kind).toBe("guard");
		expect(verdict.reasons).toContain("destructive_ratio");
	});

	it("guards absolute and topology rewrite bursts independently", () => {
		const absolute = evaluateMassChangeGuard(plan(actions("conflict", 20)), 1000);
		const topology = evaluateMassChangeGuard(plan(actions("rename_remote", 10)), 1000);
		expect(absolute.reasons).toContain("absolute_destructive_count");
		expect(topology.reasons).toContain("topology_rewrite");
	});
});
