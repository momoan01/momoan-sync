import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { addFile, createMockLocalFs, createMockRemoteFs } from "../__mocks__/sync-test-helpers";
import { createChecksumRegistry } from "../fs/modules/checksum-registry";
import type { SyncAction } from "../sync/types";
import { RecoveryJournal } from "./journal";

function text(buffer: ArrayBuffer | undefined): string {
	return buffer ? new TextDecoder().decode(buffer) : "";
}

describe("M4 Recovery Journal", () => {
	it("durably captures pre-delete bytes and never treats the row as a replay command", async () => {
		const local = createMockLocalFs();
		const remote = createMockRemoteFs();
		addFile(local, "note.md", "before", 1000);
		addFile(remote, "note.md", "before", 1000);
		const localEntity = await local.stat("note.md");
		const remoteEntity = await remote.stat("note.md");
		const action = {
			action: "delete_local", path: "note.md", local: localEntity!, remote: remoteEntity!,
		} as SyncAction;
		const journal = new RecoveryJournal(crypto.randomUUID());

		const id = await journal.captureAction(action, {
			localFs: local, remoteFs: remote, checksumRegistry: createChecksumRegistry(),
		}, "cycle-1");
		const entries = await journal.listEntries();

		expect(id).toBeTruthy();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ cycleId: "cycle-1", actionType: "delete_local", disposition: "captured" });
		expect(entries[0]!.endpoints.map((endpoint) => text(endpoint.content))).toEqual(["before", "before"]);
		await journal.close();
	});

	it("marks a verified action applied without removing its recovery material", async () => {
		const local = createMockLocalFs();
		const remote = createMockRemoteFs();
		addFile(local, "note.md", "before", 1000);
		addFile(remote, "note.md", "before", 1000);
		const action = {
			action: "delete_remote", path: "note.md",
			local: (await local.stat("note.md"))!, remote: (await remote.stat("note.md"))!,
		} as SyncAction;
		const journal = new RecoveryJournal(crypto.randomUUID());
		const id = await journal.captureAction(action, {
			localFs: local, remoteFs: remote, checksumRegistry: createChecksumRegistry(),
		}, "cycle-2");
		await journal.markApplied(id!);

		const [entry] = await journal.listEntries();
		expect(entry?.disposition).toBe("applied");
		expect(entry?.appliedAt).toBeTruthy();
		expect(entry?.endpoints).toHaveLength(2);
		await journal.close();
	});
});
