import { describe, expect, it } from "vitest";
import { planBackupRetention, type RetentionPolicy } from "./retention";
import type { BackupManifest } from "./types";

const now = new Date("2026-10-15T12:00:00.000Z");
const none: RetentionPolicy = { recentWindowMs: 0, recentCount: 0, dailyGenerations: 0, weeklyGenerations: 0, monthlyGenerations: 0 };
function manifest(snapshotId: string, createdAt: string, vaultId = "vault"): BackupManifest {
	return { version: 1, snapshotId, vaultId, trigger: "manual", createdAt, complete: true, entries: [], manifestHash: "hash" };
}
function plan(manifests: BackupManifest[], policy: Partial<RetentionPolicy>) {
	return planBackupRetention(manifests, "vault", now, { ...none, ...policy });
}

describe("explicit generational backup retention", () => {
	it("keeps multiple snapshots inside the recent window and recent count", () => {
		const snapshots = [manifest("a", "2026-10-15T11:00:00.000Z"), manifest("b", "2026-10-15T10:30:00.000Z"),
			manifest("c", "2026-10-14T09:00:00.000Z")];
		expect(plan(snapshots, { recentWindowMs: 7_200_000 }).keepSnapshotIds).toEqual(["a", "b"]);
		expect(plan(snapshots, { recentCount: 3 }).keepSnapshotIds).toEqual(["a", "b", "c"]);
	});
	it.each([
		{ tier: "dailyGenerations", older: "2026-10-14T08:00:00.000Z", newer: "2026-10-14T20:00:00.000Z", count: 2 },
		{ tier: "weeklyGenerations", older: "2026-10-12T08:00:00.000Z", newer: "2026-10-14T20:00:00.000Z", count: 1 },
		{ tier: "monthlyGenerations", older: "2026-10-01T08:00:00.000Z", newer: "2026-10-14T20:00:00.000Z", count: 1 },
	] as const)("keeps only the newest in one $tier bucket", ({ tier, older, newer, count }) => {
		expect(plan([manifest("old", older), manifest("new", newer)], { [tier]: count }))
			.toEqual({ keepSnapshotIds: ["new"], deleteSnapshotIds: ["old"] });
	});
	it("retains distinct generations and removes only current-Vault snapshots outside the policy", () => {
		const snapshots = [manifest("today", "2026-10-15T08:00:00.000Z"), manifest("yesterday", "2026-10-14T08:00:00.000Z"),
			manifest("old", "2025-01-01T08:00:00.000Z"), manifest("foreign", "2020-01-01T00:00:00.000Z", "other")];
		expect(plan(snapshots, { dailyGenerations: 2 })).toEqual({
			keepSnapshotIds: ["foreign", "today", "yesterday"], deleteSnapshotIds: ["old"],
		});
	});
	it("uses Monday UTC week boundaries across a year boundary", () => {
		const snapshots = [manifest("sunday", "2025-12-28T23:59:59.000Z"), manifest("monday", "2025-12-29T00:00:00.000Z"),
			manifest("newyear", "2026-01-01T01:00:00.000Z")];
		expect(planBackupRetention(snapshots, "vault", new Date("2026-01-01T12:00:00.000Z"), { ...none, weeklyGenerations: 2 }))
			.toEqual({ keepSnapshotIds: ["newyear", "sunday"], deleteSnapshotIds: ["monday"] });
	});
	it("uses calendar months across a year boundary", () => {
		const snapshots = [manifest("nov", "2025-11-30T23:00:00.000Z"), manifest("dec", "2025-12-31T23:00:00.000Z"),
			manifest("jan", "2026-01-01T01:00:00.000Z")];
		expect(planBackupRetention(snapshots, "vault", new Date("2026-01-01T12:00:00.000Z"), { ...none, monthlyGenerations: 2 }))
			.toEqual({ keepSnapshotIds: ["dec", "jan"], deleteSnapshotIds: ["nov"] });
	});
	it("combines tiers without thinning recent snapshots in one day", () => {
		const snapshots = [manifest("a", "2026-10-15T11:00:00.000Z"), manifest("b", "2026-10-15T10:00:00.000Z"),
			manifest("daily", "2026-10-14T08:00:00.000Z"), manifest("weekly", "2026-10-07T08:00:00.000Z"),
			manifest("monthly", "2026-09-01T08:00:00.000Z")];
		expect(plan(snapshots, { recentCount: 2, dailyGenerations: 2, weeklyGenerations: 2, monthlyGenerations: 2 }).keepSnapshotIds)
			.toEqual(["a", "b", "daily", "monthly", "weekly"]);
	});
	it("is independent of input order, trigger and equal-timestamp ordering", () => {
		const a = manifest("a", "2026-10-14T08:00:00.000Z");
		const b = { ...manifest("b", a.createdAt), trigger: "mass_change_guard" as const };
		expect(plan([b, a], { dailyGenerations: 2 })).toEqual(plan([a, b], { dailyGenerations: 2 }));
		expect(plan([b, a], { dailyGenerations: 2 }).keepSnapshotIds).toEqual(["a"]);
	});
	it("conservatively preserves future snapshots", () => {
		expect(plan([manifest("future", "2027-01-01T00:00:00.000Z")], {})).toEqual({ keepSnapshotIds: ["future"], deleteSnapshotIds: [] });
	});
	it.each([-1, 1.5, NaN, Infinity])("rejects invalid explicit policy value %s", (value) => {
		expect(() => plan([], { recentCount: value })).toThrow("retention policy");
	});
	it("rejects omitted policy fields, invalid time and empty Vault id", () => {
		expect(() => planBackupRetention([], "vault", now, {} as RetentionPolicy)).toThrow("retention policy");
		expect(() => planBackupRetention([], "vault", new Date(NaN), none)).toThrow("reference time");
		expect(() => planBackupRetention([], "", now, none)).toThrow("vault id");
	});
	it.each([
		{ complete: false }, { version: 2 }, { createdAt: "bad" }, { trigger: "unknown" },
		{ entries: [{ path: "a.md", kind: "file", size: 1, mtime: 1, contentHash: "bad" }] },
	])("fails closed on malformed or unknown manifests: %j", (invalid) => {
		const bad = { ...manifest("bad", "2020-01-01T00:00:00.000Z", "other"), ...invalid } as unknown as BackupManifest;
		expect(() => plan([bad], {})).toThrow("Invalid backup manifest");
	});
	it("rejects duplicate snapshot ids before producing a deletion plan", () => {
		const value = manifest("a", "2026-10-14T08:00:00.000Z");
		expect(() => plan([value, { ...value, vaultId: "other" }], {})).toThrow("Duplicate");
	});
});
