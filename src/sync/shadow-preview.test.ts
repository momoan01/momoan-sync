import { describe, expect, it } from "vitest";
import type { FileEntity } from "../fs/types";
import type { IdentityEvidence, MixedEntity, PathObservation, SyncRecord } from "./types";
import { admitBatchObservation } from "./plan-admission";
import { captureBatchObservation } from "./sync-cycle-planning";
import { createShadowPreview, shadowPreviewSummary } from "./shadow-preview";
function entity(path: string, hash = "h0", identityKey?: string): FileEntity {
 return { path, hash, identityKey, pathAuthority: "actual_resolved", isDirectory: false, size: 1, mtime: 1 };
}
function baseline(path: string): SyncRecord {
 return { path, hash: "h0", localMtime: 1, remoteMtime: 1, localSize: 1, remoteSize: 1, remoteIdentityKey: "id:" + path, syncedAt: 1 };
}
function admitted(entries: MixedEntity[], evidence: IdentityEvidence[] = [], remoteDeleted = false) {
 const observations: PathObservation[] = entries.flatMap(entry => (["local", "remote"] as const).map(side => entry[side]
  ? { kind: "exact" as const, side, requestedPath: entry.path, entity: entry[side] }
  : { kind: "absent" as const, side, requestedPath: entry.path, authority: side === "remote" && remoteDeleted ? "checkpoint_deleted" as const : "stat" as const }));
 return admitBatchObservation(captureBatchObservation(entries, evidence, observations,
  { byEndpoint: new Map(entries.map(entry => [entry.path, "included" as const])), isConfiguredScopeCompatible: () => true, includes: () => true }, "test-root"));
}
describe("ShadowPreviewReport Authorized Plan projection", () => {
 it.each([
  { type: "push", side: "remote", change: "create", entry: { path: "p", local: entity("p") } },
  { type: "pull", side: "local", change: "create", entry: { path: "p", remote: entity("p", "h0", "id:p") } },
  { type: "push", side: "remote", change: "update", entry: { path: "p", local: entity("p", "h1"), remote: entity("p", "h0", "id:p"), prevSync: baseline("p") } },
  { type: "pull", side: "local", change: "update", entry: { path: "p", local: entity("p"), remote: entity("p", "h1", "id:p"), prevSync: baseline("p") } },
  { type: "delete_remote", side: "remote", change: "delete", entry: { path: "p", remote: entity("p", "h0", "id:p"), prevSync: baseline("p") } },
  { type: "delete_local", side: "local", change: "delete", entry: { path: "p", local: entity("p"), prevSync: baseline("p") } },
 ] as const)("counts admitted $type as $change on $side", ({ type, side, change, entry }) => {
  const result = admitted([entry], [], type === "delete_local"); const report = createShadowPreview(result, true, true);
  expect(result.executable.actions.map(action => action.action)).toContain(type);
  expect(report.actionCounts[type]).toBe(1); expect(report.expectedChanges[change][side]).toBe(1);
  expect(report.actions.map(({ path, action }) => ({ path, action }))).toEqual(result.executable.actions.map(({ path, action }) => ({ path, action })));
  expect(report.actionCount).toBe(result.executable.actions.length); expect(Object.values(report.actionCounts).reduce((sum, count) => sum + count, 0)).toBe(report.actionCount);
 });
 it.each(["local", "remote"] as const)("projects the exact %s rename target without re-deciding", side => {
  const entries: MixedEntity[] = side === "local"
   ? [{ path: "old", remote: entity("old", "h0", "id:old"), prevSync: baseline("old") }, { path: "new", local: entity("new") }]
   : [{ path: "old", local: entity("old"), prevSync: baseline("old") }, { path: "new", remote: entity("new", "h0", "id:old") }];
  const result = admitted(entries, [{ kind: "rename", side, oldPath: "old", newPath: "new", isFolder: false, authority: "reported", ...(side === "remote" ? { identityKey: "id:old" } : {}) }]);
  const report = createShadowPreview(result, true, false); const target = side === "local" ? "remote" : "local";
  expect(report.actionCounts[target === "local" ? "rename_local" : "rename_remote"]).toBe(1); expect(report.expectedChanges.rename[target]).toBe(1);
  expect(report.actions.find(action => action.change === "rename")?.oldPath).toBe("old");
 });
 it("reports conflict protocol and admission blocking without persisting either", () => {
  const conflict = admitted([{ path: "p", local: entity("p", "h1"), remote: entity("p", "h2", "id:p"), prevSync: baseline("p") }]);
  const report = createShadowPreview(conflict, false, true); expect(report.conflictsCount).toBe(conflict.executable.actions.filter(action => action.action === "conflict").length); expect(report.conflictsCount).toBe(1);
  expect(report.actions.find(action => action.action === "conflict")?.reason).toBe("same_path");
  const bad = admitted([{ path: "unresolved", remote: { ...entity("unresolved"), pathAuthority: "requested_echo" } }]);
  const blocked = createShadowPreview(bad, false, false); expect(blocked.admissionFailureCount).toBe(bad.failures.length); expect(blocked.blockedCount).toBeGreaterThan(0); expect(blocked.blocked[0]?.reasons).toEqual(bad.failures[0]?.reasons);
 });
 it("keeps cleanup a baseline action rather than pretending it is a file delete", () => {
  const report = createShadowPreview(admitted([{ path: "p", prevSync: baseline("p") }]), true, false);
  expect(report.actionCounts.cleanup).toBe(1); expect(report.expectedChanges.delete).toEqual({ local: 0, remote: 0 });
 });
 it("reports reconciliation as suppressed and unverified, never settled", () => {
  const empty = admitted([]); const report = createShadowPreview(empty, true, true);
  expect(report.namespaceReconciliation).toBe("suppressed_unverified"); expect(report.diagnostics.join(" ")).toContain("status unverified");
  expect(createShadowPreview(empty, false, false).diagnostics).toEqual([]);
 });
 it("whitelists report fields so secret/token/code metadata and file content cannot enter it", () => {
  const local = Object.assign(entity("p"), { clientSecret: "secret-sentinel", accessToken: "token-sentinel", refreshToken: "refresh-sentinel", code: "code-sentinel", pendingCodeVerifier: "verifier-sentinel", content: "content-sentinel" });
  const report = createShadowPreview(admitted([{ path: "p", local }]), true, false);
  for (const secret of ["secret-sentinel", "token-sentinel", "refresh-sentinel", "code-sentinel", "verifier-sentinel", "content-sentinel"]) expect(JSON.stringify(report)).not.toContain(secret);
  expect(report.actions[0]).toEqual({ path: "p", action: "push", direction: "remote", change: "create" });
 });
 it("is immutable and stable across identical plans except generation metadata", () => {
  const admission = admitted([{ path: "p", local: entity("p") }]);
  const { generatedAt, previewId, ...first } = createShadowPreview(admission, true, true);
  const { generatedAt: secondTime, previewId: secondId, ...second } = createShadowPreview(admission, true, true);
  expect(first).toEqual(second); expect(previewId).not.toBe(secondId); expect(Date.parse(generatedAt)).not.toBeNaN(); expect(Date.parse(secondTime)).not.toBeNaN();
  expect(Object.isFrozen(first.actions)).toBe(true); expect(Object.isFrozen(first.expectedChanges.create)).toBe(true);
  expect(shadowPreviewSummary(createShadowPreview(admission, true, false))).toBe("Create 1 · Update 0 · Rename 0 · Delete 0 · Conflicts 0");
 });
});


it("surfaces the same Mass Change Guard verdict used by Write", () => {
 const entries = Array.from({ length: 10 }, (_, index) => ({
  path: `mass-${index}.md`,
  local: undefined,
  remote: entity(`mass-${index}.md`, "h0", `id:mass-${index}.md`),
  prevSync: baseline(`mass-${index}.md`),
 }));
 const report = createShadowPreview(admitted(entries), true, false);
 expect(report.massChange.kind).toBe("guard");
 expect(report.diagnostics.join(" ")).toContain("Mass Change Guard");
});
