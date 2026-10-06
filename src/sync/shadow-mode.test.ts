import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, syncExecutionMode } from "../settings";
import { SyncOrchestrator, type SyncOrchestratorDeps } from "./orchestrator";
import { LocalChangeTracker } from "./local-tracker";
import { createChecksumRegistry } from "../fs/modules/checksum-registry";
import { addFile, deferred, confirmMockPath, createMockLocalFs, createMockRemoteFs, mockSettings } from "../__mocks__/sync-test-helpers";
import { Logger } from "../logging/logger";
import * as executor from "./plan-executor";
import * as admissionModule from "./plan-admission";
import * as detector from "./change-detector";
// Immutable map/set facades and scope predicates have fresh function identities each cycle.
// Compare all iterable facts and action/component data, rather than closure identity.
function facts(value: unknown): string {
 return JSON.stringify(value, (_key, item: unknown) => {
  if (typeof item === "function") return "[predicate]";
  if (item && typeof item === "object" && !Array.isArray(item) && Symbol.iterator in item) return Array.from(item as Iterable<unknown>);
  return item;
 });
}
vi.mock("./error", async (importOriginal) => {
 const actual = await importOriginal<typeof import("./error")>();
 return { ...actual, sleep: () => Promise.resolve() };
});
const engines: SyncOrchestrator[] = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.close(); vi.restoreAllMocks(); });
function fixture(mode: "shadow" | "write" = "shadow", hasCheckpoint = true, logger?: Logger) {
 const settings = mockSettings({ syncMode: mode, vaultId: crypto.randomUUID(), backendType: "googledrive" });
 const local = createMockLocalFs(); const remote = createMockRemoteFs();
 const write = remote.write.bind(remote);
 remote.write = async (path, content, mtime) => { const result = await write(path, content, mtime); confirmMockPath(remote, result.path); return result; };
 addFile(local, "local.md", "local", 1000); addFile(remote, "remote.md", "remote", 1000);
 let working = false; let durable = "original";
 const list = remote.list.bind(remote); remote.list = async () => { working = true; return list(); };
 const checkpoint = {
  getChangedPaths: vi.fn().mockResolvedValue(null), hasCheckpoint: vi.fn().mockResolvedValue(hasCheckpoint),
  abortWorkingView: vi.fn().mockImplementation(() => { working = false; return Promise.resolve(); }),
  resetCheckpoint: vi.fn().mockImplementation(() => { durable = "reset"; return Promise.resolve(); }),
  commitCheckpoint: vi.fn().mockImplementation(() => { durable = "published"; working = false; return Promise.resolve(); }),
 };
 remote.checkpoint = checkpoint;
 const reconcile = vi.fn().mockResolvedValue({ kind: "settled" }); remote.namespaceReconciliation = { reconcileNamespace: reconcile };
 const tracker = new LocalChangeTracker(); tracker.markDirty("local.md");
 const acknowledge = vi.spyOn(tracker, "acknowledge"); const consume = vi.spyOn(tracker, "acknowledgeRelations");
 const save = vi.fn().mockResolvedValue(undefined); const history = vi.fn().mockResolvedValue(undefined); const status = vi.fn();
 const deps: SyncOrchestratorDeps = { logger, getSettings: () => settings, saveSettings: save, configDir: () => ".cfg", pluginId: () => "momoan-sync", localFs: () => local, remoteFs: () => remote, backendProvider: () => null, checksumRegistry: createChecksumRegistry(), onStatusChange: status, onProgress: vi.fn(), notify: vi.fn(), isMobile: () => false, localTracker: tracker, recordConflicts: history };
 const engine = new SyncOrchestrator(deps); engines.push(engine);
 const mutations = [local, remote].flatMap(fs => [vi.spyOn(fs, "write"), vi.spyOn(fs, "rename"), vi.spyOn(fs, "delete"), vi.spyOn(fs, "mkdir")]);
 const stateWrites = [vi.spyOn(engine.state, "put"), vi.spyOn(engine.state, "compareAndPut"), vi.spyOn(engine.state, "compareAndDelete"), vi.spyOn(engine.state, "delete"), vi.spyOn(engine.state, "clear"), vi.spyOn(engine.state, "compareAndRewritePaths"), vi.spyOn(engine.state, "putContent"), vi.spyOn(engine.state, "compareAndPutContent")];
 return { engine, settings, tracker, checkpoint, reconcile, acknowledge, consume, save, history, status, mutations, stateWrites, remote, local, authority: () => ({ working, durable }) };
}
function readOnly(f: ReturnType<typeof fixture>) {
 for (const spy of [...f.mutations, ...f.stateWrites, f.reconcile, f.acknowledge, f.consume, f.save, f.history, f.checkpoint.commitCheckpoint, f.checkpoint.resetCheckpoint]) expect(spy).not.toHaveBeenCalled();
 expect(f.checkpoint.abortWorkingView).toHaveBeenCalled(); expect(f.authority()).toEqual({ working: false, durable: "original" });
}
describe("M3 shadow zero-mutation contract", () => {
 it("flushes successful preview logs once while preserving all read-only authorities", async () => {
  const writeLog = vi.fn().mockResolvedValue(undefined);
  const logger = new Logger({ exists: () => Promise.resolve(true), read: () => Promise.resolve(""), write: writeLog, mkdir: () => Promise.resolve() }, () => ({ ...DEFAULT_SETTINGS, enableLogging: true, logLevel: "debug" }), "test");
  const flushLog = vi.spyOn(logger, "flush");
  const f = fixture("shadow", true, logger); const before = f.tracker.snapshot();
  await f.engine.runSync();
  expect(f.status).toHaveBeenCalledWith("shadow_ready");
  expect(flushLog).toHaveBeenCalledOnce(); expect(writeLog).toHaveBeenCalled();
  readOnly(f); expect(f.tracker.snapshot()).toEqual(before); expect(await f.engine.state.getAll()).toEqual([]);
 });
 it("defaults new and mode-less settings to shadow", () => {
  expect(DEFAULT_SETTINGS.syncMode).toBe("shadow"); expect(syncExecutionMode({})).toBe("shadow"); expect(syncExecutionMode({ syncMode: "write" })).toBe("write");
 });
 it("uses the identical observation, admission and authorized plan before Write execution", async () => {
  const admit = vi.spyOn(admissionModule, "admitBatchObservation"); const execute = vi.spyOn(executor, "executePlan");
  const f = fixture(); const originalTracker = f.tracker.snapshot(); await f.engine.runSync();
  const shadow = admit.mock.results[0]?.value as ReturnType<typeof admissionModule.admitBatchObservation>;
  expect(shadow.executable.actions.length).toBeGreaterThan(0); expect(execute).not.toHaveBeenCalled(); readOnly(f);
  expect(await f.engine.state.getAll()).toEqual([]); expect(f.tracker.snapshot()).toEqual(originalTracker);
  f.settings.syncMode = "write"; await f.engine.runSync();
  const write = admit.mock.results[1]?.value as ReturnType<typeof admissionModule.admitBatchObservation>;
  expect(facts(write.snapshot)).toEqual(facts(shadow.snapshot)); expect(facts(write.executable)).toEqual(facts(shadow.executable));
  expect(facts(execute.mock.calls[0]?.[0])).toEqual(facts(shadow.executable)); expect(f.checkpoint.commitCheckpoint).toHaveBeenCalledOnce(); expect(f.acknowledge).toHaveBeenCalledOnce();
 });
 it("repeated previews retain baseline, checkpoint, dirty paths and rename relations", async () => {
  const f = fixture(); f.tracker.markRenamed("new.md", "old.md"); const before = f.tracker.snapshot(); const admit = vi.spyOn(admissionModule, "admitBatchObservation");
  await f.engine.runSync(); await f.engine.runSync(); readOnly(f);
  expect(facts(admit.mock.results[1]?.value)).toEqual(facts(admit.mock.results[0]?.value)); expect(f.tracker.snapshot()).toEqual(before); expect(await f.engine.state.getAll()).toEqual([]); expect(f.checkpoint.abortWorkingView).toHaveBeenCalledTimes(2);
 });
 it("mode-less persisted settings never execute a plan", async () => {
  const f = fixture(); delete f.settings.syncMode; const execute = vi.spyOn(executor, "executePlan"); await f.engine.runSync(); expect(execute).not.toHaveBeenCalled(); readOnly(f);
 });
 it("opened-file priority requests a preview without priority mutation", async () => {
  const f = fixture(); const execute = vi.spyOn(executor, "executePlan"); await f.engine.pullSingle("remote.md"); expect(execute).not.toHaveBeenCalled(); readOnly(f); expect(f.status).toHaveBeenCalledWith("shadow_ready");
 });
 it("cold rescan forces only its preview observation without resetting checkpoint", async () => {
  const f = fixture(); const collect = vi.spyOn(detector, "collectChanges"); await f.engine.rescan(); readOnly(f); expect(collect.mock.calls[0]?.[1]?.forceFullScan).toBe(true);
  await f.engine.runSync(); expect(collect.mock.calls[1]?.[1]?.forceFullScan).toBe(false); readOnly(f);
 });
 it("no checkpoint and scope change each permit a full read-only observation", async () => {
  const f = fixture("shadow", false); const collect = vi.spyOn(detector, "collectChanges"); await f.engine.runSync(); expect(collect.mock.calls[0]?.[1]?.forceFullScan).toBe(true); readOnly(f);
 });
 it("observation errors discard working view without publishing any authority", async () => {
  const f = fixture(); vi.spyOn(f.remote, "list").mockRejectedValue(new Error("Observation unavailable")); await f.engine.runSync(); readOnly(f); expect(f.status).toHaveBeenCalledWith("error");
 });
 it("Write rescan retains reset, reconciliation, execution and commit semantics", async () => {
  const f = fixture("write"); await f.engine.rescan(); expect(f.checkpoint.resetCheckpoint).toHaveBeenCalledOnce(); expect(f.reconcile).toHaveBeenCalled(); expect(f.checkpoint.commitCheckpoint).toHaveBeenCalled(); expect(f.acknowledge).toHaveBeenCalled();
 });
});


describe("M3 preview session lifecycle", () => {
 it("publishes the exact admitted plan after abort, with a detached read-only accessor", async () => {
  const f = fixture(); const admit = vi.spyOn(admissionModule, "admitBatchObservation"); expect(f.engine.getLatestShadowPreview()).toBeNull();
  await f.engine.runSync(); readOnly(f); const report = f.engine.getLatestShadowPreview();
  const result = admit.mock.results[0]?.value as ReturnType<typeof admissionModule.admitBatchObservation>;
  expect(report?.actions.map(({ path, action }) => ({ path, action }))).toEqual(result.executable.actions.map(({ path, action }) => ({ path, action })));
  expect(report?.actionCount).toBe(result.executable.actions.length); expect(report?.namespaceReconciliation).toBe("suppressed_unverified");
  if (!report) throw new Error("Missing preview"); Object.assign(report, { actionCount: -1 }); expect(f.engine.getLatestShadowPreview()?.actionCount).toBeGreaterThan(0);
  expect(f.status).not.toHaveBeenCalledWith("idle");
 });
 it("does not retain a successful report when a new preview fails", async () => {
  const f = fixture(); await f.engine.runSync(); expect(f.engine.getLatestShadowPreview()).not.toBeNull();
  vi.spyOn(f.remote, "list").mockRejectedValue(new Error("Observation failed")); await f.engine.runSync(); expect(f.engine.getLatestShadowPreview()).toBeNull(); readOnly(f);
 });
 it("scope-change forces full preview without resetting or committing checkpoint", async () => {
  const f = fixture(); f.remote.checkpoint = { ...f.checkpoint, getScopeFingerprint: vi.fn().mockResolvedValue("other-root") };
  await f.engine.runSync(); expect(f.engine.getLatestShadowPreview()?.fullScan).toBe(true); readOnly(f);
 });
 it("retains a previously committed baseline through update/delete/conflict previews", async () => {
  const f = fixture("write"); addFile(f.local, "conflict.md", "original", 1000); await f.engine.runSync();
  const baseline = await f.engine.state.getAll(); const durable = f.authority().durable;
  f.settings.syncMode = "shadow"; addFile(f.local, "local.md", "updated", 2000); f.local.files.delete("remote.md");
  addFile(f.local, "conflict.md", "local edit", 2000); addFile(f.remote, "conflict.md", "remote edit", 3000);
  f.tracker.markDirty("local.md"); f.tracker.markDirty("remote.md"); f.tracker.markDirty("conflict.md"); const tracker = f.tracker.snapshot();
  vi.clearAllMocks(); await f.engine.runSync(); await f.engine.runSync();
  for (const spy of [...f.mutations, ...f.stateWrites, f.reconcile, f.acknowledge, f.consume, f.save, f.history, f.checkpoint.commitCheckpoint, f.checkpoint.resetCheckpoint]) expect(spy).not.toHaveBeenCalled();
  expect(await f.engine.state.getAll()).toEqual(baseline); expect(f.tracker.snapshot()).toEqual(tracker); expect(f.authority()).toEqual({ working: false, durable });
  const report = f.engine.getLatestShadowPreview(); expect(report?.actionCounts.push).toBeGreaterThan(0); expect(report?.actionCounts.delete_remote).toBe(1); expect(report?.conflictsCount).toBe(1);
 });
});


describe("Shadow opened-file coalescing", () => {
 it("coalesces file-open during observation into another preview with zero mutation", async () => {
  const f = fixture(); const entered = deferred<void>(); const release = deferred<void>(); const list = f.remote.list.bind(f.remote);
  vi.spyOn(f.remote, "list").mockImplementationOnce(async () => { entered.resolve(); await release.promise; return list(); });
  const execute = vi.spyOn(executor, "executePlan"); const cycle = f.engine.runSync(); await entered.promise;
  await f.engine.pullSingle("remote.md"); release.resolve(); await cycle;
  expect(execute).not.toHaveBeenCalled(); expect(f.checkpoint.abortWorkingView).toHaveBeenCalledTimes(2); readOnly(f);
 });
});
