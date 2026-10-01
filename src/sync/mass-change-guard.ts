import type { AuthorizedSyncPlan } from "./plan-admission";
import { isTopologyRewriteAction, requiresRecoveryCapture } from "./destructive-action";

export interface MassChangeThresholds {
	absoluteDestructive: number;
	minTrackedForRatio: number;
	destructiveRatio: number;
	topologyRewrite: number;
}

/** Conservative implementation defaults; intentionally not persisted product settings. */
export const DEFAULT_MASS_CHANGE_THRESHOLDS: Readonly<MassChangeThresholds> = Object.freeze({
	absoluteDestructive: 20,
	minTrackedForRatio: 10,
	destructiveRatio: 0.5,
	topologyRewrite: 10,
});

export interface MassChangeMetrics {
	readonly tracked: number;
	readonly destructive: number;
	readonly topology: number;
	readonly destructiveRatio: number;
}

export type MassChangeGuardVerdict =
	| { readonly kind: "allow"; readonly metrics: MassChangeMetrics; readonly reasons: readonly string[] }
	| { readonly kind: "guard"; readonly metrics: MassChangeMetrics; readonly reasons: readonly string[] };

export function evaluateMassChangeGuard(
	plan: AuthorizedSyncPlan,
	tracked: number,
	thresholds: Readonly<MassChangeThresholds> = DEFAULT_MASS_CHANGE_THRESHOLDS,
): MassChangeGuardVerdict {
	const destructive = plan.actions.filter(requiresRecoveryCapture).length;
	const topology = plan.actions.filter(isTopologyRewriteAction).length;
	const safeTracked = Math.max(0, tracked);
	const destructiveRatio = safeTracked > 0 ? destructive / safeTracked : 0;
	const metrics = Object.freeze({ tracked: safeTracked, destructive, topology, destructiveRatio });
	const reasons: string[] = [];
	if (destructive >= thresholds.absoluteDestructive) reasons.push("absolute_destructive_count");
	if (safeTracked >= thresholds.minTrackedForRatio && destructiveRatio >= thresholds.destructiveRatio) {
		reasons.push("destructive_ratio");
	}
	if (topology >= thresholds.topologyRewrite) reasons.push("topology_rewrite");
	const frozenReasons = Object.freeze(reasons);
	return Object.freeze({ kind: reasons.length > 0 ? "guard" : "allow", metrics, reasons: frozenReasons });
}
