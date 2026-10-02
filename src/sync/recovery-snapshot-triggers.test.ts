import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { SyncOrchestrator } from "./orchestrator";
import { LocalChangeTracker } from "./local-tracker";
import { RecoveryJournal } from "../recovery/journal";
import { createChecksumRegistry } from "../fs/modules/checksum-registry";
import { addFile, createMockLocalFs, createMockRemoteFs, mockSettings } from "../__mocks__/sync-test-helpers";
import type { Logger } from "../logging/logger";

const instances: SyncOrchestrator[] = [];
beforeEach(() => {
	vi.stubGlobal("window", {
		setTimeout: (callback: () => void) => { callback(); return 0; },
	});
});
afterEach(async () => {
	try {
		for (const instance of instances.splice(0)) await instance.close();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
async function fixture(cold: boolean, count = 5, shadow = false, fail = false) {
	const settings = mockSettings({ vaultId: crypto.randomUUID(), syncMode: shadow ? "shadow" : "write", backendType: "none" });
	const local = createMockLocalFs(); const remote = createMockRemoteFs();
	const tracker = new LocalChangeTracker(); const events: string[] = [];
	if (!cold) tracker.acknowledge(tracker.snapshot()); // HOT requires an initialized tracker before dirty inputs.
	const snapshot = vi.fn((trigger: string) => {
		events.push("snapshot:" + trigger);
		return fail ? Promise.reject(new Error("safety disk full")) : Promise.resolve({ snapshotId: "safe" });
	});
	const warn = vi.fn((message: string) => {
		if (message === "Mass Change Guard requested a cold re-observation") events.push("cold requested");
		if (message === "Mass Change Guard safety capture completed") events.push("journal");
	});
	const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), enabled: vi.fn().mockReturnValue(true), flush: vi.fn().mockResolvedValue(undefined) } as unknown as Logger;
	remote.checkpoint = {
		getChangedPaths: () => Promise.resolve({ modified: [], deleted: [] }),
		hasCheckpoint: () => Promise.resolve(!cold),
		commitCheckpoint: () => Promise.resolve(),
		abortWorkingView: () => Promise.resolve(),
		resetCheckpoint: () => Promise.resolve(),
	};
	const list = remote.list.bind(remote);
	const fullScan = vi.spyOn(remote, "list").mockImplementation(() => {
		events.push("full observation"); return list();
	});
	const remove = remote.delete.bind(remote);
	const deletion = vi.spyOn(remote, "delete").mockImplementation((path) => {
		events.push("delete:" + path); return remove(path);
	});
	const journal = vi.spyOn(RecoveryJournal.prototype, "capturePlan");
	const orchestrator = new SyncOrchestrator({
		getSettings: () => settings, saveSettings: () => Promise.resolve(),
		configDir: () => ".cfg", pluginId: () => "test-plugin",
		localFs: () => local, remoteFs: () => remote, backendProvider: () => null,
		checksumRegistry: createChecksumRegistry(), isMobile: () => false,
		onStatusChange: vi.fn(), onProgress: vi.fn(), notify: vi.fn(), localTracker: tracker,
		logger, createSafetySnapshot: snapshot,
	});
	instances.push(orchestrator);
	for (let index = 0; index < 10; index++) {
		const path = "p" + index + ".md";
		addFile(local, path, "original"); addFile(remote, path, "original");
		const localEntity = (await local.stat(path))!; const remoteEntity = (await remote.stat(path))!;
		await orchestrator.state.put({ path, hash: localEntity.hash, localMtime: 1000, remoteMtime: 1000,
			localSize: localEntity.size, remoteSize: remoteEntity.size, remoteIdentityKey: remoteEntity.identityKey!, syncedAt: 1000 });
		if (index < count) { local.files.delete(path); tracker.markDirty(path); }
		else if (!cold) tracker.markDirty(path); // Include unchanged baselines in the HOT guard denominator.
	}
	return { orchestrator, events, snapshot, journal, deletion, fullScan, remote };
}

describe("Guarded safety snapshot trigger provenance", () => {
	it("re-observes a HOT guard cold and snapshots before destructive execution", async () => {
		const f = await fixture(false);
		await f.orchestrator.runSync();
		expect(f.events).toContain("cold requested");
		expect(f.fullScan).toHaveBeenCalled();
		expect(f.events.indexOf("cold requested")).toBeLessThan(f.events.indexOf("full observation"));
		expect(f.snapshot).toHaveBeenCalledOnce();
		expect(f.snapshot).toHaveBeenCalledWith("mass_change_guard");
		expect(f.journal).toHaveBeenCalledOnce();
		expect(f.deletion).toHaveBeenCalledTimes(5);
		expect(f.fullScan.mock.invocationCallOrder[0]).toBeLessThan(f.snapshot.mock.invocationCallOrder[0]!);
		expect(f.snapshot.mock.invocationCallOrder[0]).toBeLessThan(f.journal.mock.invocationCallOrder[0]!);
		expect(f.snapshot.mock.invocationCallOrder[0]).toBeLessThan(f.deletion.mock.invocationCallOrder[0]!);
	});
	it("uses recovery_cold for an already-cold destructive guarded plan", async () => {
		const f = await fixture(true);
		await f.orchestrator.runSync();
		expect(f.snapshot).toHaveBeenCalledWith("recovery_cold");
		expect(f.snapshot).toHaveBeenCalledOnce(); expect(f.deletion).toHaveBeenCalledTimes(5);
		expect(f.events.indexOf("journal")).toBeGreaterThan(f.events.indexOf("snapshot:recovery_cold"));
	});
	it("does not snapshot ordinary cold plans below the mass guard threshold", async () => {
		const f = await fixture(true, 1);
		await f.orchestrator.runSync();
		expect(f.snapshot).not.toHaveBeenCalled(); expect(f.deletion).toHaveBeenCalledOnce();
	});
	it("fails closed before journal/executor and does not retry a failed mandatory snapshot", async () => {
		const f = await fixture(true, 5, false, true);
		await f.orchestrator.runSync();
		expect(f.snapshot).toHaveBeenCalledOnce(); expect(f.snapshot).toHaveBeenCalledWith("recovery_cold");
		expect(f.journal).not.toHaveBeenCalled(); expect(f.deletion).not.toHaveBeenCalled();
		expect(f.remote.files.size).toBe(10);
	});
	it("never takes a safety snapshot or mutates in a Shadow cold preview", async () => {
		const f = await fixture(true, 5, true);
		await f.orchestrator.runSync();
		expect(f.snapshot).not.toHaveBeenCalled(); expect(f.journal).not.toHaveBeenCalled();
		expect(f.deletion).not.toHaveBeenCalled(); expect(f.remote.files.size).toBe(10);
	});
});
