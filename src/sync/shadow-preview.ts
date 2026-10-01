import type { AdmissionResult } from "./plan-admission";
import type { SyncAction, SyncActionType } from "./types";
import { evaluateMassChangeGuard, type MassChangeGuardVerdict } from "./mass-change-guard";
export type PreviewDirection = "local" | "remote" | "both" | "none";
export type PreviewChange = "create" | "update" | "rename" | "delete";
export interface ShadowPreviewAction {
 readonly path: string;
 readonly action: SyncActionType;
 readonly direction: PreviewDirection;
 readonly change?: PreviewChange;
 readonly reason?: string;
 readonly oldPath?: string;
}
export interface ShadowPreviewReport {
 readonly generatedAt: string;
 readonly previewId: string;
 readonly fullScan: boolean;
 readonly actionCount: number;
 readonly actionCounts: Readonly<Record<SyncActionType, number>>;
 readonly conflictsCount: number;
 /** Unique paths rejected by Admission, not hypothetical executor failures. */
 readonly blockedCount: number;
 readonly admissionFailureCount: number;
 /** Principal admitted actions, grouped by their target side; no replanning of conflicts. */
 readonly expectedChanges: Readonly<Record<PreviewChange, Readonly<{local: number; remote: number}>>>;
 readonly actions: readonly ShadowPreviewAction[];
 readonly blocked: readonly { readonly path: string; readonly reasons: readonly string[] }[];
 readonly namespaceReconciliation: "suppressed_unverified" | "not_available";
 readonly massChange: MassChangeGuardVerdict;
 readonly diagnostics: readonly string[];
}
function projectAction(action: SyncAction): ShadowPreviewAction {
 const base = { path: action.path, action: action.action };
 switch (action.action) {
  case "push": return { ...base, direction: "remote", change: action.remote ? "update" : "create" };
  case "pull": return { ...base, direction: "local", change: action.local ? "update" : "create" };
  case "rename_local": return { ...base, direction: "local", change: "rename", oldPath: action.oldPath };
  case "rename_remote": return { ...base, direction: "remote", change: "rename", oldPath: action.oldPath };
  case "delete_local": return { ...base, direction: "local", change: "delete" };
  case "delete_remote": return { ...base, direction: "remote", change: "delete" };
  case "conflict": return { ...base, direction: "both", reason: action.protocol.kind };
  case "match": case "cleanup": return { ...base, direction: "none" };
 }
}
/** Whitelisted projection of the exact Authorized Plan. No settings, credentials or file contents. */
export function createShadowPreview(admission: AdmissionResult, fullScan: boolean, namespaceRepairAvailable: boolean): ShadowPreviewReport {
 const actionCounts: Record<SyncActionType, number> = { push: 0, pull: 0, rename_local: 0, rename_remote: 0, delete_local: 0, delete_remote: 0, conflict: 0, match: 0, cleanup: 0 };
 const expectedChanges = { create: { local: 0, remote: 0 }, update: { local: 0, remote: 0 }, rename: { local: 0, remote: 0 }, delete: { local: 0, remote: 0 } };
 const actions = admission.executable.actions.map(action => {
  actionCounts[action.action]++;
  const projected = projectAction(action);
  if (projected.change && (projected.direction === "local" || projected.direction === "remote")) expectedChanges[projected.change][projected.direction]++;
  return Object.freeze(projected);
 });
 const blocked = admission.failures.flatMap(failure => failure.paths.map(path => Object.freeze({ path, reasons: Object.freeze([...failure.reasons]) })));
 for (const counts of Object.values(expectedChanges)) Object.freeze(counts);
 const massChange = evaluateMassChangeGuard(admission.executable, admission.snapshot.baselinePaths.size);
 const diagnostics = [
  ...(namespaceRepairAvailable ? ["Namespace reconciliation would be required if contention exists; repair suppressed in shadow, status unverified."] : []),
  ...(massChange.kind === "guard" ? ["Mass Change Guard would require a cold re-observation and durable safety capture before Write execution."] : []),
 ];
 return Object.freeze({ generatedAt: new Date().toISOString(), previewId: crypto.randomUUID(), fullScan,
  actionCount: actions.length, actionCounts: Object.freeze(actionCounts), conflictsCount: actionCounts.conflict,
  blockedCount: new Set(blocked.map(item => item.path)).size, admissionFailureCount: admission.failures.length,
  expectedChanges: Object.freeze(expectedChanges), actions: Object.freeze(actions), blocked: Object.freeze(blocked),
  namespaceReconciliation: namespaceRepairAvailable ? "suppressed_unverified" : "not_available",
  massChange, diagnostics: Object.freeze(diagnostics),
 });
}
export function shadowPreviewSummary(report: ShadowPreviewReport): string {
 const total = (change: PreviewChange) => report.expectedChanges[change].local + report.expectedChanges[change].remote;
 return "Create " + total("create") + " · Update " + total("update") + " · Rename " + total("rename") + " · Delete " + total("delete") + " · Conflicts " + report.conflictsCount;
}
