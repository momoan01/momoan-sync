import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBHelper, SchemaMigrationSafetyError, normalizeIdbError, sanitizeDbName } from "./idb-helper";
import { SyncStateStore } from "../sync/state";
import { MetadataStore } from "./metadata-store";

const helpers: IDBHelper[] = [];
afterEach(async () => { for (const helper of helpers.splice(0)) await helper.close(); vi.restoreAllMocks(); });
function helper(dbName: string, version: number, events: string[], snapshot?: () => Promise<unknown>): IDBHelper {
	const result = new IDBHelper({ dbName, version, destructiveUpgrade: { createSnapshot: snapshot },
		onUpgrade: (db, oldVersion) => {
			events.push("upgrade:" + oldVersion);
			if (oldVersion > 0) { events.push("delete"); db.deleteObjectStore("items"); }
			db.createObjectStore("items", { keyPath: "id" });
		} });
	helpers.push(result);
	return result;
}
async function seed(name: string, version = 1): Promise<void> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name, version);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains("items")) request.result.createObjectStore("items", { keyPath: "id" });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(normalizeIdbError(request.error, "IndexedDB request failed"));
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction("items", "readwrite");
			tx.objectStore("items").put({ id: "kept", bytes: "original" });
			tx.oncomplete = () => resolve(); tx.onerror = () => reject(normalizeIdbError(tx.error, "IndexedDB transaction failed"));
		});
	} finally { db.close(); }
}
async function read(name: string): Promise<unknown> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onsuccess = () => resolve(request.result); request.onerror = () => reject(normalizeIdbError(request.error, "IndexedDB request failed"));
	});
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction("items", "readonly");
			const request = tx.objectStore("items").get("kept");
			tx.oncomplete = () => resolve(request.result as unknown); tx.onerror = () => reject(normalizeIdbError(tx.error, "IndexedDB transaction failed"));
		});
	} finally { db.close(); }
}
function name(): string { return "schema-safety-" + crypto.randomUUID(); }

describe("Destructive schema snapshot preflight", () => {
	it("creates a new DB without a schema snapshot", async () => {
		const snapshot = vi.fn().mockResolvedValue(undefined);
		const events: string[] = [];
		await helper(name(), 2, events, snapshot).open();
		expect(snapshot).not.toHaveBeenCalled(); expect(events).toEqual(["upgrade:0"]);
	});
	it("opens a current DB without snapshot or upgrade", async () => {
		const dbName = name(); await seed(dbName, 2);
		const snapshot = vi.fn().mockResolvedValue(undefined); const events: string[] = [];
		await helper(dbName, 2, events, snapshot).open();
		expect(snapshot).not.toHaveBeenCalled(); expect(events).toEqual([]);
		expect(await read(dbName)).toEqual({ id: "kept", bytes: "original" });
	});
	it("finishes the snapshot before target-version open and store deletion", async () => {
		const dbName = name(); await seed(dbName);
		const events: string[] = [];
		const open = indexedDB.open.bind(indexedDB);
		vi.spyOn(indexedDB, "open").mockImplementation((database, version) => {
			if (version === 2) events.push("target open");
			return version === undefined ? open(database) : open(database, version);
		});
		const h = helper(dbName, 2, events, () => { events.push("snapshot complete"); return Promise.resolve(); });
		await h.open();
		expect(events).toEqual(["snapshot complete", "target open", "upgrade:1", "delete"]);
		expect(await read(dbName)).toBeUndefined();
	});
	it("never starts target-version open after snapshot failure and preserves old data", async () => {
		const dbName = name(); await seed(dbName);
		const openSpy = vi.spyOn(indexedDB, "open"); const events: string[] = [];
		const snapshot = vi.fn().mockRejectedValue(new Error("backup unavailable"));
		await expect(helper(dbName, 2, events, snapshot).open()).rejects.toThrow("backup unavailable");
		expect(openSpy.mock.calls.some(([, version]) => version === 2)).toBe(false);
		expect(events).toEqual([]); expect(snapshot).toHaveBeenCalledOnce();
		expect(await read(dbName)).toEqual({ id: "kept", bytes: "original" });
	});
	it("fails closed without a mandatory snapshot dependency", async () => {
		const dbName = name(); await seed(dbName); const events: string[] = [];
		await expect(helper(dbName, 2, events).open()).rejects.toBeInstanceOf(SchemaMigrationSafetyError);
		expect(events).toEqual([]); expect(await read(dbName)).toEqual({ id: "kept", bytes: "original" });
	});
	it("aborts before destructive onUpgrade when the preflight version became stale", async () => {
		const dbName = name(); await seed(dbName); const events: string[] = [];
		const h = helper(dbName, 3, events, async () => { await seed(dbName, 2); });
		await expect(h.open()).rejects.toThrow("version changed after preflight");
		expect(events).toEqual([]); expect(await read(dbName)).toEqual({ id: "kept", bytes: "original" });
	});
	it("aborts if the old database was removed after the snapshot", async () => {
		const dbName = name(); await seed(dbName); const events: string[] = [];
		const h = helper(dbName, 2, events, () => new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(dbName);
			request.onsuccess = () => resolve(); request.onerror = () => reject(normalizeIdbError(request.error, "IndexedDB request failed"));
		}));
		await expect(h.open()).rejects.toThrow("version changed after preflight");
		expect(events).toEqual([]);
	});
	it("a failed proof can be retried only with a fresh preflight and new snapshot", async () => {
		const dbName = name(); await seed(dbName); const events: string[] = [];
		const snapshot = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
		const h = helper(dbName, 2, events, snapshot);
		await expect(h.open()).rejects.toThrow("busy"); await h.open();
		expect(snapshot).toHaveBeenCalledTimes(2); expect(events).toEqual(["upgrade:1", "delete"]);
	});
	it("SyncStateStore wires the mandatory snapshot before its real destructive schema seam", async () => {
		const vaultId = crypto.randomUUID(); const dbName = "air-sync-" + sanitizeDbName(vaultId);
		await seed(dbName, 8);
		const snapshot = vi.fn().mockRejectedValue(new Error("mobile or missing backup"));
		const state = new SyncStateStore(vaultId, snapshot);
		try {
			await expect(state.open()).rejects.toThrow("mobile or missing backup");
			expect(snapshot).toHaveBeenCalledOnce();
			expect(await read(dbName)).toEqual({ id: "kept", bytes: "original" });
		} finally { await state.close(); }
	});
	it("cache-only schema replacement remains re-derivable and does not require a vault snapshot", async () => {
		const vaultId = crypto.randomUUID(); const prefix = "cache-audit";
		await seed(prefix + "-" + sanitizeDbName(vaultId));
		const cache = new MetadataStore(vaultId, { dbNamePrefix: prefix, version: 2 });
		try { await cache.open(); expect((await cache.loadAll()).files).toEqual([]); }
		finally { await cache.close(); }
	});
});
