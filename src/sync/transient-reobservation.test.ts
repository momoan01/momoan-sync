import { describe, expect, it } from "vitest";
import { LocalChangeTracker } from "./local-tracker";
import type { SyncCycleOutcome } from "./sync-notification";
import type { SyncAction } from "./types";
import { isBenignLocalSupersession } from "./transient-reobservation";

function fixture() {
 const tracker = new LocalChangeTracker(); tracker.markDirty("note.md"); tracker.markDirty("other.md");
 const snapshot = tracker.snapshot(); tracker.markDirty("note.md"); tracker.markDirty("other.md");
 const outcome: SyncCycleOutcome = {
  execution: { succeeded: [], superseded: [], conflicts: [], failed: [], blocked: [
   { action: { action: "push", path: "note.md" }, reason: "opaque", classification: "precondition_changed", localSupersession: true },
   { action: { action: "push", path: "other.md" }, reason: "opaque", classification: "precondition_changed", localSupersession: true },
  ] }, admissionFailures: [], completion: { kind: "incomplete" },
 };
 return { tracker, snapshot, outcome };
}

describe("benign local supersession", () => {
 it("requires every structured blocked push to have newer producer input", () => {
  const f = fixture(); expect(isBenignLocalSupersession(f.outcome, f.snapshot, f.tracker)).toBe(true);
  expect(isBenignLocalSupersession(f.outcome, f.tracker.snapshot(), f.tracker)).toBe(false);
 });
 it("uses the actual local endpoint rather than the canonical path", () => {
  const f = fixture(); f.outcome.execution.blocked[0]!.action.localPath = "unmodified.md";
  expect(isBenignLocalSupersession(f.outcome, f.snapshot, f.tracker)).toBe(false);
  f.tracker.markDirty("unmodified.md");
  expect(isBenignLocalSupersession(f.outcome, f.snapshot, f.tracker)).toBe(true);
 });
 it("rejects unknown or non-local proof origin even with a newer local generation", () => {
  const f = fixture(); delete f.outcome.execution.blocked[0]!.localSupersession;
  expect(isBenignLocalSupersession(f.outcome, f.snapshot, f.tracker)).toBe(false);
 });
 it("rejects legacy snapshots without generation evidence", () => {
  const f = fixture(); expect(isBenignLocalSupersession(f.outcome, { ...f.snapshot, generations: undefined }, f.tracker)).toBe(false);
 });
 it("does not parse reasons or hide component-prefix blocks", () => {
  const f = fixture(); delete f.outcome.execution.blocked[0]!.classification;
  f.outcome.execution.blocked[0]!.reason = "Content source changed: note.md";
  expect(isBenignLocalSupersession(f.outcome, f.snapshot, f.tracker)).toBe(false);
 });
 it.each<SyncAction>([
  { action: "pull", path: "note.md" }, { action: "delete_local", path: "note.md" },
  { action: "rename_local", path: "note.md", oldPath: "old.md" },
  { action: "conflict", path: "note.md", protocol: { kind: "same_path" }, conflictPolicy: { mode: "preserve", strategy: "duplicate" } },
 ])("does not hide $action blocks", action => {
  const f = fixture(); f.outcome.execution.blocked[0]!.action = action;
  expect(isBenignLocalSupersession(f.outcome, f.snapshot, f.tracker)).toBe(false);
 });
 it.each(["target_changed", "permission", "auth", "transient", "permanent"])("does not hide %s failed actions, including mixed cycles", kind => {
  const f = fixture(); f.outcome.execution.failed.push({ action: { action: "push", path: "note.md" }, error: Object.assign(new Error("opaque"), { kind }) });
  expect(isBenignLocalSupersession(f.outcome, f.snapshot, f.tracker)).toBe(false);
  f.outcome.execution.blocked = [];
  expect(isBenignLocalSupersession(f.outcome, f.snapshot, f.tracker)).toBe(false);
 });
 it("rejects admission failures and empty block collections", () => {
  const f = fixture(); f.outcome.admissionFailures.push({ kind: "failed", reasons: ["unknown_observation"], actions: [], paths: [], evidence: [] });
  expect(isBenignLocalSupersession(f.outcome, f.snapshot, f.tracker)).toBe(false);
  f.outcome.admissionFailures = []; f.outcome.execution.blocked = [];
  expect(isBenignLocalSupersession(f.outcome, f.snapshot, f.tracker)).toBe(false);
 });
});
