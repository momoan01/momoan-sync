/* eslint max-lines: ["error", 350] -- one resolver owns stable version capture, selected-strategy resolution, and verified preservation of those exact inputs. */
import type { IFileSystem } from "../fs/interface";
import type { ChecksumRegistry } from "../fs/modules/checksum-registry";
import type { FileEntity } from "../fs/types";
import type { Logger } from "../logging/logger";
import { getFileExtension } from "../utils/path";
import {
	generateConflictPath, insertConflictSuffix, remoteReplacementInputs,
	type ConflictResolutionResult, type ConflictInputSnapshots, type VerifiedConflictOutput,
} from "./conflict";
import { bytesMatch, captureContentSnapshot, ContentProofError, type ExactSnapshot, type StableVersionWitness } from "./content-snapshot";
import { isMergeEligible, threeWayMerge } from "./merge";
import type { SyncStateStore } from "./state";
import type { ConflictExecutionPolicy, SyncRecord } from "./types";

export interface ConflictResolverContext {
	path: string;
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	local?: FileEntity;
	remote?: FileEntity;
	baseline?: SyncRecord;
	localPath?: string;
	remotePath?: string;
	remoteIdentitySource?: FileEntity;
	additionalRemote?: FileEntity;
	additionalLocal?: FileEntity;
	stateStore?: SyncStateStore;
	checksumRegistry: ChecksumRegistry;
	logger?: Logger;
	/** Detached executor captures, never resolver-owned source authority. */
	inputSnapshots?: ConflictInputSnapshots;
	/** Run exact copy mutations under the executor-owned path barrier. */
	mutatePreservation?: (path: string, operation: () => Promise<void>) => Promise<void>;
}


export interface PreservationObligation {
	readonly role: "primary" | "additional" | "local";
	readonly sourcePath: string;
	readonly identityKey?: string;
}

export type PreparedConflict =
	| {
		readonly kind: "prepared_no_rotation";
		readonly primary: ExactSnapshot;
		readonly additional: readonly [] | readonly [ExactSnapshot];
		readonly local?: ExactSnapshot;
		readonly obligations: readonly PreservationObligation[];
	}
	| {
		readonly kind: "prepared_rotation_required";
		readonly source: FileEntity;
		readonly sourceWitness: StableVersionWitness;
		readonly primary: ExactSnapshot;
		readonly additional: readonly [] | readonly [ExactSnapshot];
		readonly local?: ExactSnapshot;
		readonly obligations: readonly PreservationObligation[];
	};


export type { ConflictResolutionResult };

/** Bounded read-only capture; no path allocation, resolver call, or mutation. */
export async function prepareConflict(ctx: ConflictResolverContext): Promise<PreparedConflict> {
	if (!ctx.remote) throw new ContentProofError("proof_mismatch", "Conflict primary is absent");
	const primary = ctx.inputSnapshots?.remote ?? await captureContentSnapshot(
		ctx.remoteFs, ctx.remotePath ?? ctx.remote.path, ctx.remote, ctx.checksumRegistry);
	const additional = ctx.additionalRemote
		? [ctx.inputSnapshots?.additionalRemote ?? await captureContentSnapshot(
			ctx.remoteFs, ctx.additionalRemote.path, ctx.additionalRemote, ctx.checksumRegistry)] as const
		: [] as const;
	const local = ctx.additionalLocal
		? ctx.inputSnapshots?.additionalLocal ?? await captureContentSnapshot(
			ctx.localFs, ctx.additionalLocal.path, ctx.additionalLocal, ctx.checksumRegistry) : undefined;
	const obligations = Object.freeze([
		obligation("primary", primary),
		...additional.map((value) => obligation("additional", value)),
		...(local ? [obligation("local", local)] : []),
	]);
	const source = ctx.remoteIdentitySource;
	if (source && source.path !== ctx.path) {
		if (source.path !== primary.path || source.identityKey !== primary.entity.identityKey) {
			throw new ContentProofError("proof_mismatch", "Prepared primary does not match rotation source");
		}
		return Object.freeze({
			kind: "prepared_rotation_required", source, sourceWitness: primary.witness,
			primary, additional, local, obligations,
		});
	}
	return Object.freeze({ kind: "prepared_no_rotation", primary, additional, local, obligations });
}

/** One resolver: capture inputs, select policy, verify required copies; never mutate originals. */
export async function resolveConflict(
	ctx: ConflictResolverContext,
	policy: ConflictExecutionPolicy,
): Promise<ConflictResolutionResult> {
	const local = ctx.local
		? ctx.inputSnapshots?.local ?? await captureContentSnapshot(ctx.localFs, ctx.localPath ?? ctx.local.path, ctx.local, ctx.checksumRegistry)
		: undefined;
	if (!ctx.remote) {
		return { action: local ? "duplicated" : "kept_local", targetContent: local?.content, targetMtime: ctx.local?.mtime ?? 0,
			verifiedOutputs: [], capturedInputs: { local } };
	}
	const prepared = await prepareConflict(ctx);
	if (policy.mode === "remote_preserve") {
		if (!local || !prepared.local) throw new ContentProofError("proof_mismatch", "Replacement local inputs are absent");
		const outputs = await preserveSnapshots(ctx, remoteReplacementInputs(local, prepared.primary, prepared.local), true);
		return { action: "kept_remote", targetContent: prepared.primary.content.slice(0),
			targetMtime: prepared.primary.entity.mtime, verifiedOutputs: outputs,
			capturedInputs: { local, remote: prepared.primary, additionalLocal: prepared.local } };
	}
	const resolution = await resolvePreparedWithPolicy(
		ctx, policy, prepared.primary, local,
	);
	const compound = !!ctx.remoteIdentitySource && ctx.remoteIdentitySource.path !== ctx.path || !!ctx.additionalRemote || !!ctx.additionalLocal ||
		ctx.local?.path !== undefined && ctx.local.path !== ctx.path || ctx.remote.path !== ctx.path;
	const outputs = compound || (resolution.action === "duplicated" && local)
		? await preserveAll(ctx, prepared) : [];
	return { ...resolution, duplicatePath: resolution.action === "duplicated" ? outputs[0]?.path : undefined,
		verifiedOutputs: outputs, capturedInputs: { local, remote: prepared.primary } };
}

/** Reuse only a fully observed pair with the exact captured source bytes. */
async function reusableReplacementPath(
	ctx: ConflictResolverContext, snapshot: ExactSnapshot, used: ReadonlySet<string>,
): Promise<{ path: string; reuse: boolean; local?: FileEntity; remote?: FileEntity }> {
	for (let index = 1; index <= 100; index++) {
		const path = insertConflictSuffix(ctx.path, index);
		if (used.has(path)) continue;
		const local = await ctx.localFs.stat(path);
		const remote = await ctx.remoteFs.stat(path);
		if (!local && !remote) return { path, reuse: false };
		if (!local || !remote) throw new ContentProofError("proof_mismatch", `Partial preservation candidate: ${path}`);
		if (local.path !== path || remote.path !== path ||
			local.pathAuthority !== "actual_resolved" || remote.pathAuthority !== "actual_resolved" ||
			local.isDirectory || remote.isDirectory) {
			throw new ContentProofError("proof_mismatch", `Unresolved preservation candidate: ${path}`);
		}
		const left = await captureContentSnapshot(ctx.localFs, path, local, ctx.checksumRegistry);
		const right = await captureContentSnapshot(ctx.remoteFs, path, remote, ctx.checksumRegistry);
		if (buffersEqual(left.content, snapshot.content) && buffersEqual(right.content, snapshot.content)) {
			return { path, reuse: true, local: Object.freeze({ ...local }), remote: Object.freeze({ ...remote }) };
		}
	}
	throw new ContentProofError("proof_mismatch", "No proved replacement preservation address available");
}

async function proveReusableCopy(
	fs: IFileSystem, path: string, entity: FileEntity | null, expected: FileEntity | undefined,
	snapshot: ExactSnapshot, registry: ChecksumRegistry,
): Promise<void> {
	if (!entity || !expected || entity.path !== path || entity.pathAuthority !== "actual_resolved" || entity.isDirectory ||
		entity.identityKey !== expected.identityKey) {
		throw new ContentProofError("proof_mismatch", `Preservation candidate changed: ${path}`);
	}
	const current = await captureContentSnapshot(fs, path, expected, registry);
	if (!buffersEqual(current.content, snapshot.content)) {
		throw new ContentProofError("proof_mismatch", `Preservation candidate bytes changed: ${path}`);
	}
}

/** Consume Admission's closed policy without reinterpreting the configured setting. */
async function resolvePreparedWithPolicy(
	ctx: ConflictResolverContext,
	policy: ConflictExecutionPolicy,
	primary: ExactSnapshot,
	localSnapshot?: ExactSnapshot,
): Promise<ConflictResolutionResult> {
	const localContent = localSnapshot?.content.slice(0);
	if (policy.mode === "preserve") {
		return {
			action: "duplicated",
			targetContent: localContent ?? primary.content.slice(0),
			targetMtime: ctx.local?.mtime ?? primary.entity.mtime,
		};
	}
	if (policy.mode === "local_win") {
		if (!localContent || !ctx.local) throw new Error("Prefer-local local-win input is missing");
		return { action: "kept_local", targetContent: localContent, targetMtime: ctx.local.mtime };
	}
	if (!localContent || !ctx.local) {
		return {
			action: "kept_remote", targetContent: primary.content.slice(0),
			targetMtime: primary.entity.mtime,
		};
	}
	// The merge base belongs to the baseline record's remote object, so it is read by
	// the identity that record already names — no address, and nothing to re-derive
	// when that object is answering at a different endpoint this cycle.
	const base = ctx.baseline && ctx.stateStore
		? await ctx.stateStore.getContent(ctx.baseline.remoteIdentityKey)
		: undefined;
	if (base && isMergeEligible(ctx.path, Math.max(ctx.local.size, primary.entity.size))) {
		const decoder = new TextDecoder();
		const merged = threeWayMerge(
			decoder.decode(base), decoder.decode(localContent), decoder.decode(primary.content),
		);
		const extension = getFileExtension(ctx.path);
		if ((extension === ".json" || extension === ".canvas") &&
			(merged.hasConflicts || !isValidJson(merged.content))) {
			return { action: "duplicated", targetContent: localContent, targetMtime: ctx.local.mtime };
		}
		return {
			action: "merged", hasConflictMarkers: merged.hasConflicts,
			targetContent: new TextEncoder().encode(merged.content).buffer.slice(0),
			targetMtime: Date.now(),
		};
	}
	if (ctx.local.mtime > 0 && primary.entity.mtime > 0 &&
		ctx.local.mtime < primary.entity.mtime) {
		return {
			action: "kept_remote", targetContent: primary.content.slice(0),
			targetMtime: primary.entity.mtime,
		};
	}
	if (ctx.local.mtime > 0 && primary.entity.mtime > 0 &&
		ctx.local.mtime > primary.entity.mtime) {
		return { action: "kept_local", targetContent: localContent, targetMtime: ctx.local.mtime };
	}
	if (buffersEqual(localContent, primary.content)) {
		return { action: "kept_local", targetContent: localContent, targetMtime: ctx.local.mtime };
	}
	return {
		action: "duplicated",
		targetContent: localContent, targetMtime: ctx.local.mtime,
	};
}

async function preserveAll(
	ctx: ConflictResolverContext,
	prepared: PreparedConflict,
): Promise<readonly VerifiedConflictOutput[]> {
	const snapshots = [
		{ role: "primary" as const, snapshot: prepared.primary },
		...prepared.additional.map((snapshot) => ({ role: "additional" as const, snapshot })),
		...(prepared.local ? [{ role: "local" as const, snapshot: prepared.local }] : []),
	];
	return preserveSnapshots(ctx, snapshots);
}

async function preserveSnapshots(
	ctx: ConflictResolverContext,
	snapshots: readonly { role: VerifiedConflictOutput["role"]; snapshot: ExactSnapshot }[],
	proveVacancy = false,
): Promise<readonly VerifiedConflictOutput[]> {
	const outputs: VerifiedConflictOutput[] = [];
	for (const { role, snapshot } of snapshots) {
		const candidate = proveVacancy
			? await reusableReplacementPath(ctx, snapshot, new Set(outputs.map(({ path }) => path)))
			: { path: await generateConflictPath(ctx.path, ctx.localFs, ctx.remoteFs), reuse: false,
				local: undefined, remote: undefined };
		const { path, reuse } = candidate;
		const endpoints: FileEntity[] = [];
		const preserve = async () => {
			for (const fs of [ctx.localFs, ctx.remoteFs]) {
				const before = await fs.stat(path);
				if (reuse) {
					await proveReusableCopy(fs, path, before, fs === ctx.localFs ? candidate.local : candidate.remote,
						snapshot, ctx.checksumRegistry);
				} else {
					if (proveVacancy && before) {
						throw new ContentProofError("proof_mismatch", `Preservation destination appeared: ${path}`);
					}
					await fs.write(path, snapshot.content.slice(0), snapshot.entity.mtime);
				}
			}
			for (const fs of [ctx.localFs, ctx.remoteFs]) {
				const entity = await fs.stat(path);
				if (!entity || (!await bytesMatch(snapshot.content, entity, ctx.checksumRegistry) &&
					!buffersEqual(snapshot.content, await fs.read(path)))) {
					throw new ContentProofError("proof_mismatch", `Conflict output readback mismatch: ${path}`);
				}
				endpoints.push(Object.freeze({ ...entity }));
			}
		};
		if (ctx.mutatePreservation) await ctx.mutatePreservation(path, preserve);
		else await preserve();
		outputs.push(Object.freeze({
			role, path, sourcePath: snapshot.path,
			sourceEntity: snapshot.entity,
			sourceContent: snapshot.content.slice(0),
			localEntity: endpoints[0], remoteEntity: endpoints[1],
		}));
	}
	return Object.freeze(outputs);
}


function obligation(role: PreservationObligation["role"], value: ExactSnapshot): PreservationObligation {
	return Object.freeze({ role, sourcePath: value.path, identityKey: value.entity.identityKey });
}

function isValidJson(content: string): boolean {
	try {
		JSON.parse(content);
		return true;
	} catch {
		return false;
	}
}

function buffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	return a.every((value, index) => value === b[index]);
}
