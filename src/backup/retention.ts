import { assertCompleteBackupManifest } from "./manifest";
import type { BackupManifest } from "./types";

/** All values are explicit: this core supplies no production retention defaults. */
export interface RetentionPolicy {
	readonly recentWindowMs: number;
	readonly recentCount: number;
	readonly dailyGenerations: number;
	readonly weeklyGenerations: number;
	readonly monthlyGenerations: number;
}

export interface RetentionPlan {
	/** Includes foreign-Vault snapshots, which are never retention deletion targets. */
	readonly keepSnapshotIds: readonly string[];
	readonly deleteSnapshotIds: readonly string[];
}

const DAY_MS = 86_400_000;

/** UTC calendar buckets include the reference day/week/month; weeks begin Monday.
 * Tiers are a union, not a quota: recent snapshots can coexist within one day.
 * Future-dated snapshots are conservatively kept. Equal timestamps use id order.
 * Invalid/unknown manifests or policies fail closed rather than becoming deletions.
 */
export function planBackupRetention(
	manifests: readonly BackupManifest[],
	vaultId: string,
	referenceTime: Date,
	policy: RetentionPolicy,
): RetentionPlan {
	if (!vaultId.trim()) throw new Error("Retention requires a vault id");
	const now = referenceTime.getTime();
	if (!Number.isFinite(now)) throw new Error("Invalid retention reference time");
	for (const value of [policy.recentWindowMs, policy.recentCount, policy.dailyGenerations,
		policy.weeklyGenerations, policy.monthlyGenerations]) {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid explicit retention policy");
	}
	const ids = new Set<string>();
	for (const manifest of manifests) {
		assertCompleteBackupManifest(manifest);
		if (ids.has(manifest.snapshotId)) throw new Error("Duplicate backup snapshot id");
		ids.add(manifest.snapshotId);
	}
	const current = manifests.filter((manifest) => manifest.vaultId === vaultId).map((manifest) => ({
		manifest, time: Date.parse(manifest.createdAt),
	})).sort((a, b) => b.time - a.time || compareIds(a.manifest.snapshotId, b.manifest.snapshotId));
	const keep = new Set(manifests.filter((manifest) => manifest.vaultId !== vaultId).map((manifest) => manifest.snapshotId));
	const daily = new Set<number>();
	const weekly = new Set<number>();
	const monthly = new Set<number>();
	const referenceDay = Math.floor(now / DAY_MS);
	const referenceWeek = Math.floor((referenceDay + 3) / 7);
	const referenceMonth = referenceTime.getUTCFullYear() * 12 + referenceTime.getUTCMonth();
	let recentIndex = 0;
	for (const { manifest, time } of current) {
		const id = manifest.snapshotId;
		if (time > now) { keep.add(id); continue; }
		if (recentIndex++ < policy.recentCount || (policy.recentWindowMs > 0 && now - time <= policy.recentWindowMs)) keep.add(id);
		const date = new Date(time);
		const day = Math.floor(time / DAY_MS);
		const week = Math.floor((day + 3) / 7);
		const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
		for (const [bucket, reference, generations, seen] of [
			[day, referenceDay, policy.dailyGenerations, daily],
			[week, referenceWeek, policy.weeklyGenerations, weekly],
			[month, referenceMonth, policy.monthlyGenerations, monthly],
		] as const) {
			if (reference - bucket < generations && !seen.has(bucket)) {
				seen.add(bucket);
				keep.add(id);
			}
		}
	}
	return Object.freeze({
		keepSnapshotIds: Object.freeze([...keep].sort(compareIds)),
		deleteSnapshotIds: Object.freeze(current.filter(({ manifest }) => !keep.has(manifest.snapshotId))
			.map(({ manifest }) => manifest.snapshotId).sort(compareIds)),
	});
}

function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
