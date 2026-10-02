import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import { requireMassChangeSafetySnapshot } from "./mass-change-safety-snapshot";
import type { MassChangeGuardVerdict } from "./mass-change-guard";

const verdict: Extract<MassChangeGuardVerdict, { readonly kind: "guard" }> = {
	kind: "guard",
	metrics: { tracked: 10, destructive: 5, topology: 0, destructiveRatio: 0.5 },
	reasons: ["destructive_ratio"],
};

function logger(warn = vi.fn()): Logger {
	return { warn } as unknown as Logger;
}

describe("Mass Change Guard safety snapshot", () => {
	it("fails closed when no safety snapshot provider is wired", async () => {
		await expect(requireMassChangeSafetySnapshot(undefined, undefined, verdict))
			.rejects.toThrow("requires a local safety snapshot");
	});

	it("propagates snapshot failure before destructive execution can continue", async () => {
		const createSnapshot = vi.fn().mockRejectedValue(new Error("disk full"));

		await expect(requireMassChangeSafetySnapshot(createSnapshot, undefined, verdict))
			.rejects.toThrow("disk full");
		expect(createSnapshot).toHaveBeenCalledTimes(1);
	});

	it("logs the completed snapshot with guard metrics", async () => {
		const warn = vi.fn();
		await requireMassChangeSafetySnapshot(
			() => Promise.resolve({ snapshotId: "snapshot-safe" }), logger(warn), verdict);

		expect(warn).toHaveBeenCalledWith("Mass Change Guard safety snapshot completed", {
			snapshotId: "snapshot-safe",
			trigger: "mass_change_guard",
			tracked: 10,
			destructive: 5,
			topology: 0,
			destructiveRatio: 0.5,
		});
	});
});

// The caller selects provenance; provider state and error-message parsing never do.
it("passes recovery_cold through the mandatory snapshot boundary", async () => {
	const createSnapshot = vi.fn().mockResolvedValue({ snapshotId: "recovery" });
	await requireMassChangeSafetySnapshot(createSnapshot, undefined, verdict, "recovery_cold");
	expect(createSnapshot).toHaveBeenCalledWith("recovery_cold");
});
