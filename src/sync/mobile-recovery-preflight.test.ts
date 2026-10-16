import { describe, expect, it } from "vitest";
import type { IFileSystem } from "../fs/interface";
import type { ChecksumRegistry } from "../fs/modules/checksum-registry";
import type { RecoveryJournal } from "../recovery/journal";
import type { RecoveryJournalEntry } from "../recovery/types";
import type { SyncAction } from "./types";
import { MobileRecoveryPreflightError, prepareMobileRecoveryCaptures } from "./mobile-recovery-preflight";

const file = (path: string) => ({
	path, isDirectory: false, size: 3, mtime: 0, hash: "",
	pathAuthority: "actual_resolved" as const,
});
const remove = (path = "note.md"): SyncAction => ({
	action: "delete_local", path, local: file(path), remote: file(path),
});
const context = {
	localFs: { name: "local" } as IFileSystem,
	remoteFs: { name: "remote" } as IFileSystem,
	checksumRegistry: {} as ChecksumRegistry,
};
const bytes = () => new Uint8Array([1, 2, 3]).buffer;

function stubJournal(options: {
	failWrite?: boolean;
	editRows?: (rows: RecoveryJournalEntry[]) => RecoveryJournalEntry[];
} = {}) {
	let writes = 0;
	const rows: RecoveryJournalEntry[] = [];
	const journal = {
		capturePlan: (actions: readonly SyncAction[], _ctx: unknown, cycleId: string) => {
			writes++;
			if (options.failWrite) return Promise.reject(new Error("quota exceeded"));
			const map = new Map<SyncAction, string>();
			for (const [index, action] of actions.entries()) {
				const id = `row-${index}`;
				rows.push({
					id, cycleId, actionType: action.action,
					path: action.path, sourcePath: action.path,
					destinationPath: action.path,
					capturedAt: "2026-10-16T00:00:00Z", disposition: "captured",
					endpoints: [
						...(action.local ? [{ side: "local" as const, path: action.local.path,
							entity: action.local, content: bytes() }] : []),
						...(action.remote ? [{ side: "remote" as const, path: action.remote.path,
							entity: action.remote, content: bytes() }] : []),
					],
				});
				map.set(action, id);
			}
			return Promise.resolve(map);
		},
		listEntries: () => Promise.resolve(options.editRows?.(structuredClone(rows)) ?? structuredClone(rows)),
	};
	return { journal: journal as Pick<RecoveryJournal, "capturePlan" | "listEntries">,
		writes: () => writes };
}

describe("mobile recovery: complete batch proof before effects", () => {
	it("does not capture a non-destructive push", async () => {
		const { journal, writes } = stubJournal();
		expect(await prepareMobileRecoveryCaptures([{ action: "push", path: "new.md", local: file("new.md") }],
			journal, context, "cycle")).toBeUndefined();
		expect(writes()).toBe(0);
	});
	it("pre-captures all destructive actions and verifies journal readback", async () => {
		const { journal, writes } = stubJournal();
		const a = remove("first.md");
		const b = remove("second.md");
		const output = await prepareMobileRecoveryCaptures([a, b], journal, context, "cycle");
		expect(output?.get(a)).toBe("row-0");
		expect(output?.get(b)).toBe("row-1");
		expect(writes()).toBe(1);
	});
	it("blocks whole-folder renames BEFORE journal writing", async () => {
		const { journal, writes } = stubJournal();
		await expect(prepareMobileRecoveryCaptures([{
			action: "rename_local", oldPath: "old", path: "new", isFolder: true,
		}], journal, context, "cycle")).rejects.toBeInstanceOf(MobileRecoveryPreflightError);
		expect(writes()).toBe(0);
	});
	it("blocks when IndexedDB persistence fails", async () => {
		const { journal } = stubJournal({ failWrite: true });
		await expect(prepareMobileRecoveryCaptures([remove()], journal, context, "cycle"))
			.rejects.toThrow("quota exceeded");
	});
	it("blocks when a journal row cannot be read back", async () => {
		const { journal } = stubJournal({ editRows: () => [] });
		await expect(prepareMobileRecoveryCaptures([remove()], journal, context, "cycle"))
			.rejects.toThrow("read-back mismatch");
	});
	it("blocks on missing endpoint content", async () => {
		const { journal } = stubJournal({ editRows: (rows) => rows.map((row) => ({
			...row, endpoints: row.endpoints.map((endpoint) => ({
				...endpoint, content: undefined,
			})),
		})) });
		await expect(prepareMobileRecoveryCaptures([remove()], journal, context, "cycle"))
			.rejects.toThrow("exact bytes");
	});
	it("blocks on a journal entry from a different cycle", async () => {
		const { journal } = stubJournal({ editRows: (rows) => rows.map((row) => ({
			...row, cycleId: "another",
		})) });
		await expect(prepareMobileRecoveryCaptures([remove()], journal, context, "cycle"))
			.rejects.toThrow("read-back mismatch");
	});
});
