import type { IFileSystem } from "../fs/interface";
import type { ChecksumRegistry } from "../fs/modules/checksum-registry";
import type { FileEntity } from "../fs/types";
import { captureContentSnapshot, ContentProofError } from "../sync/content-snapshot";
import { requiresRecoveryCapture } from "../sync/destructive-action";
import type { SyncAction } from "../sync/types";
import { RecoveryJournalStore } from "./store";
import type { RecoveryEndpointSnapshot, RecoveryJournalEntry } from "./types";

export interface RecoveryCaptureContext {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	checksumRegistry: ChecksumRegistry;
}

export class RecoveryJournal {
	private readonly store: RecoveryJournalStore;

	constructor(vaultId: string) {
		this.store = new RecoveryJournalStore(vaultId);
	}

	async captureAction(
		action: SyncAction,
		ctx: RecoveryCaptureContext,
		cycleId: string,
	): Promise<string | undefined> {
		if (!requiresRecoveryCapture(action)) return undefined;
		if (!cycleId) throw new Error("Recovery capture requires a cycle id");

		const endpoints: RecoveryEndpointSnapshot[] = [];
		const seen = new Set<string>();
		const capture = async (side: "local" | "remote", entity: FileEntity | undefined) => {
			if (!entity) return;
			const key = `${side}:${entity.path}:${entity.identityKey ?? ""}`;
			if (seen.has(key)) return;
			seen.add(key);
			endpoints.push(await captureEndpoint(side, entity, side === "local" ? ctx.localFs : ctx.remoteFs, ctx.checksumRegistry));
		};

		await capture("local", action.local);
		await capture("remote", action.remote);
		if (action.action === "conflict") {
			await capture("local", action.additionalLocal);
			await capture("remote", action.additionalRemote);
		}

		const sourcePath = action.action === "rename_local" || action.action === "rename_remote"
			? action.oldPath : action.local?.path ?? action.remote?.path ?? action.path;
		const entry: RecoveryJournalEntry = {
			id: crypto.randomUUID(),
			cycleId,
			actionType: action.action,
			path: action.path,
			entityId: action.remoteIdentitySource?.identityKey ?? action.remote?.identityKey ?? action.baseline?.remoteIdentityKey,
			sourcePath,
			destinationPath: action.path,
			capturedAt: new Date().toISOString(),
			baseline: action.baseline ? { ...action.baseline } : undefined,
			endpoints,
			disposition: "captured",
		};
		await this.store.put(entry);
		return entry.id;
	}

	/** Pre-capture an entire guarded plan before its first destructive effect. */
	async capturePlan(
		actions: readonly SyncAction[],
		ctx: RecoveryCaptureContext,
		cycleId: string,
	): Promise<ReadonlyMap<SyncAction, string>> {
		const captured = new Map<SyncAction, string>();
		for (const action of actions) {
			const id = await this.captureAction(action, ctx, cycleId);
			if (id) captured.set(action, id);
		}
		return captured;
	}

	async markApplied(id: string): Promise<void> {
		if (!await this.store.markApplied(id, new Date().toISOString())) {
			throw new Error(`Recovery journal entry disappeared before disposition: ${id}`);
		}
	}

	listEntries(): Promise<RecoveryJournalEntry[]> {
		return this.store.getAll();
	}

	close(): Promise<void> {
		return this.store.close();
	}
}

async function captureEndpoint(
	side: "local" | "remote",
	observed: FileEntity,
	fs: IFileSystem,
	registry: ChecksumRegistry,
): Promise<RecoveryEndpointSnapshot> {
	if (!observed.isDirectory) {
		const captured = await captureContentSnapshot(fs, observed.path, observed, registry);
		return { side, path: observed.path, entity: { ...captured.entity }, content: captured.content.slice(0) };
	}
	const current = await fs.stat(observed.path);
	if (!current || current.path !== observed.path || current.isDirectory !== true ||
		(observed.identityKey && current.identityKey !== observed.identityKey)) {
		throw new ContentProofError("proof_mismatch", `Recovery source changed: ${observed.path}`);
	}
	return { side, path: observed.path, entity: { ...current } };
}
