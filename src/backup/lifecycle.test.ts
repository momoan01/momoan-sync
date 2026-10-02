import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupLifecycle, normalizeBackupIntervalMinutes } from "./lifecycle";
import mainSource from "../main.ts?raw";

const lifecycles: BackupLifecycle[] = [];
afterEach(() => { for (const lifecycle of lifecycles.splice(0)) lifecycle.stop(); });

function fixture(mobile = false, directory = "/backup", minutes = 0) {
	const settings = { backupDirectory: directory, backupIntervalMinutes: minutes };
	const createSnapshot = vi.fn().mockResolvedValue({ snapshotId: "safe" });
	const info = vi.fn();
	const warn = vi.fn();
	const timers = new Map<number, () => void>();
	const setInterval = vi.fn((callback: () => void, _milliseconds: number) => {
		const id = timers.size + 1;
		timers.set(id, callback);
		return id;
	});
	let ready = true;
	const lifecycle = new BackupLifecycle({
		getSettings: () => settings,
		isMobile: () => mobile,
		isLayoutReady: () => ready,
		createSnapshot,
		logger: { info, warn },
		setInterval,
		clearInterval: (id) => { timers.delete(id); },
	});
	lifecycles.push(lifecycle);
	return { lifecycle, settings, createSnapshot, info, warn, timers, setInterval,
		setReady: (value: boolean) => { ready = value; },
		tick: () => { for (const callback of timers.values()) callback(); } };
}
function flush(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("Backup lifecycle", () => {
	it("runs stabilized startup once before ordinary sync, including concurrent requests", async () => {
		const f = fixture();
		const events: string[] = [];
		const gate = deferred();
		f.createSnapshot.mockImplementation(async (trigger: string) => {
			events.push(trigger);
			await gate.promise;
			events.push("snapshot complete");
			return { snapshotId: "safe" };
		});
		const first = f.lifecycle.withSync(() => { events.push("sync"); return Promise.resolve(); });
		const second = f.lifecycle.withSync(() => Promise.resolve());
		expect(events).toEqual(["startup"]);
		gate.resolve();
		await Promise.all([first, second]);
		await f.lifecycle.withSync(() => Promise.resolve());
		expect(events).toEqual(["startup", "snapshot complete", "sync"]);
		expect(f.createSnapshot).toHaveBeenCalledOnce();
	});

	it("warns on startup failure and still runs ordinary sync", async () => {
		const f = fixture();
		f.createSnapshot.mockRejectedValue(new Error("disk full"));
		const sync = vi.fn().mockResolvedValue(undefined);
		await f.lifecycle.withSync(sync);
		expect(sync).toHaveBeenCalledOnce();
		expect(f.warn).toHaveBeenCalledWith("Background snapshot failed", { trigger: "startup", message: "disk full" });
	});

	it.each([[true, "/backup"], [false, ""], [false, "  "]])("skips unavailable startup and timers (%s, %s)", async (mobile, directory) => {
		const f = fixture(mobile, directory, 1);
		f.lifecycle.configure();
		await f.lifecycle.withSync(() => Promise.resolve());
		expect(f.createSnapshot).not.toHaveBeenCalled();
		expect(f.setInterval).not.toHaveBeenCalled();
	});

	it("does not consume startup or register timers before layout-ready", async () => {
		const f = fixture(false, "/backup", 1);
		f.setReady(false);
		f.lifecycle.configure();
		await f.lifecycle.withSync(() => Promise.resolve());
		expect(f.createSnapshot).not.toHaveBeenCalled();
		f.setReady(true);
		await f.lifecycle.withSync(() => Promise.resolve());
		expect(f.createSnapshot).toHaveBeenCalledWith("startup");
	});

	it("has no production cadence and uses the explicit positive interval", async () => {
		const f = fixture();
		f.lifecycle.configure();
		expect(f.setInterval).not.toHaveBeenCalled();
		f.settings.backupIntervalMinutes = 3;
		f.lifecycle.configure();
		expect(f.setInterval).toHaveBeenCalledWith(expect.any(Function), 180000);
		f.tick();
		await flush();
		expect(f.createSnapshot).toHaveBeenCalledWith("interval");
	});

	it("drops overlapping ticks, waits before sync, and does not queue them", async () => {
		const f = fixture(false, "/backup", 1);
		await f.lifecycle.withSync(() => Promise.resolve());
		f.createSnapshot.mockClear();
		const gate = deferred();
		f.createSnapshot.mockImplementation(async () => { await gate.promise; return { snapshotId: "interval" }; });
		f.lifecycle.configure();
		f.tick(); f.tick(); f.tick();
		const sync = vi.fn().mockResolvedValue(undefined);
		const running = f.lifecycle.withSync(sync);
		expect(sync).not.toHaveBeenCalled();
		expect(f.createSnapshot).toHaveBeenCalledOnce();
		gate.resolve();
		await running;
		await flush();
		expect(sync).toHaveBeenCalledOnce();
		expect(f.createSnapshot).toHaveBeenCalledOnce();
	});

	it("does not snapshot during sync and resumes on a later tick", async () => {
		const f = fixture(false, "/backup", 1);
		await f.lifecycle.withSync(() => Promise.resolve());
		f.createSnapshot.mockClear();
		f.lifecycle.configure();
		const gate = deferred();
		const sync = f.lifecycle.withSync(() => gate.promise);
		f.tick();
		expect(f.createSnapshot).not.toHaveBeenCalled();
		gate.resolve(); await sync;
		f.tick(); await flush();
		expect(f.createSnapshot).toHaveBeenCalledWith("interval");
	});

	it("surfaces a busy BackupService conflict and allows the next interval", async () => {
		const f = fixture(false, "/backup", 1);
		f.lifecycle.configure();
		f.createSnapshot.mockRejectedValueOnce(new Error("Backup is already running"));
		f.tick(); await flush();
		expect(f.warn).toHaveBeenCalledOnce();
		f.tick(); await flush();
		expect(f.createSnapshot).toHaveBeenCalledTimes(2);
		expect(f.info).toHaveBeenCalledOnce();
	});

	it("unrelated settings saves do not postpone the selected cadence", () => {
		const f = fixture(false, "/backup", 1);
		f.lifecycle.configure(); f.lifecycle.configure(); f.lifecycle.configure();
		expect(f.setInterval).toHaveBeenCalledOnce();
		f.settings.backupIntervalMinutes = 2; f.lifecycle.configure();
		expect(f.setInterval).toHaveBeenCalledTimes(2);
		expect(f.timers.size).toBe(1);
	});

	it("cancels the timer on unload and ignores a previously queued callback", async () => {
		const f = fixture(false, "/backup", 1);
		f.lifecycle.configure();
		const callback = [...f.timers.values()][0]!;
		f.lifecycle.stop();
		callback(); await flush();
		await f.lifecycle.withSync(() => Promise.resolve());
		expect(f.timers.size).toBe(0);
		expect(f.createSnapshot).not.toHaveBeenCalled();
	});

	it("main routes scheduler sync and priority work through the lifecycle gate", () => {
		expect(mainSource).toContain("runSync: () => this.runSync()");
		expect(mainSource).toContain("this.backupLifecycle.withSync(() => this.orchestrator.pullSingle(path))");
		expect(mainSource).toContain("this.backupLifecycle.configure()");
		expect(mainSource).toContain("this.register(() => this.backupLifecycle.stop())");
		expect(mainSource).toContain('createSafetySnapshot: (trigger) => this.backupService.createSnapshot(trigger)');
		expect(mainSource).toContain('createSchemaMigrationSnapshot: () => this.backupService.createSnapshot("schema_migration")');
	});
});

describe("Explicit interval normalization", () => {
	it.each([undefined, null, "5", -1, 1.5, NaN, Infinity, 1000000])("disables invalid persisted cadence %s", (value) => {
		expect(normalizeBackupIntervalMinutes(value)).toBe(0);
	});
	it("retains safe explicit whole-minute values", () => {
		expect(normalizeBackupIntervalMinutes(0)).toBe(0);
		expect(normalizeBackupIntervalMinutes(60)).toBe(60);
	});
});
