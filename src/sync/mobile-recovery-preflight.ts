import type { IFileSystem } from "../fs/interface";
import type { ChecksumRegistry } from "../fs/modules/checksum-registry";
import type { RecoveryJournal } from "../recovery/journal";
import { requiresRecoveryCapture } from "./destructive-action";
import type { SyncAction } from "./types";

/**
 * Before any mobile destructive WRITE, capture the whole admitted batch and
 * independently READ BACK the durable IndexedDB journal rows. This does not
 * replace an independent external backup, which remains unavailable on mobile;
 * the existing Mass Change Guard must still fail closed without one.
 *
 * The journal stores directory metadata only. Folder structural actions may
 * affect children not covered by the journal: fail closed until full descendant
 * capture + restore is proven, rather than misrepresenting metadata as a backup.
 */
export class MobileRecoveryPreflightError extends Error {
  readonly permanent = true;
  readonly permanentCode = "mobile_recovery_preflight_failed";
  constructor(message: string) {
    super(message);
    this.name = "MobileRecoveryPreflightError";
  }
}

export async function prepareMobileRecoveryCaptures(
  actions: readonly SyncAction[],
  journal: Pick<RecoveryJournal, "capturePlan" | "listEntries">,
  context: { localFs: IFileSystem; remoteFs: IFileSystem; checksumRegistry: ChecksumRegistry },
  cycleId: string,
): Promise<ReadonlyMap<SyncAction, string> | undefined> {
  const destructive = actions.filter(requiresRecoveryCapture);
  if (destructive.length === 0) return undefined;
  if (!cycleId) throw new MobileRecoveryPreflightError("Mobile recovery requires a cycle ID");
  for (const action of destructive) {
    if (("isFolder" in action && action.isFolder) ||
      action.local?.isDirectory || action.remote?.isDirectory ||
      action.additionalLocal?.isDirectory || action.additionalRemote?.isDirectory) {
      throw new MobileRecoveryPreflightError(
        `Mobile directory change needs a verified descendant recovery path: ${action.path}`,
      );
    }
  }

  let captured: ReadonlyMap<SyncAction, string>;
  try {
    captured = await journal.capturePlan(destructive, context, cycleId);
    if (captured.size !== destructive.length) throw new Error("Incomplete recovery capture map");
    // A resolved IDB write isn't independently verifiable until a new READ
    // transaction returns the committed rows and exact endpoint content.
    const persisted = await journal.listEntries();
    const byId = new Map(persisted.map(entry => [entry.id, entry]));
    const capturedIds = new Set<string>();
    for (const action of destructive) {
      const id = captured.get(action);
      if (!id || capturedIds.has(id)) throw new Error("Missing or reused recovery entry ID");
      capturedIds.add(id);
      const row = byId.get(id);
      if (!row || row.cycleId !== cycleId || row.actionType !== action.action ||
          row.destinationPath !== action.path || row.disposition !== "captured") {
        throw new Error(`Recovery read-back mismatch for ${action.path}`);
      }
      const expected = [
        ...(action.local ? [{ side: "local", path: action.local.path }] : []),
        ...(action.remote ? [{ side: "remote", path: action.remote.path }] : []),
        ...(action.action === "conflict" && action.additionalLocal
          ? [{ side: "local", path: action.additionalLocal.path }] : []),
        ...(action.action === "conflict" && action.additionalRemote
          ? [{ side: "remote", path: action.additionalRemote.path }] : []),
      ];
      for (const endpoint of expected) {
        const matching = row.endpoints.find(e => e.side === endpoint.side && e.path === endpoint.path);
        if (!matching || matching.entity.isDirectory ||
          !(matching.content instanceof ArrayBuffer) ||
          matching.content.byteLength !== matching.entity.size) {
          throw new Error(`Recovery read-back missing exact bytes for ${endpoint.path}`);
        }
      }
    }
  } catch (error) {
    throw new MobileRecoveryPreflightError(
      `Mobile recovery preflight blocked Write: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return captured;
}
