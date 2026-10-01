import { IDBHelper, sanitizeDbName } from "../store/idb-helper";
import type { RecoveryJournalEntry } from "./types";

const DB_VERSION = 1;
const STORE_NAME = "recovery-journal";

/** Independent failure domain from the sync baseline/checkpoint stores. */
export class RecoveryJournalStore {
	private readonly helper: IDBHelper;

	constructor(vaultId: string) {
		this.helper = new IDBHelper({
			dbName: `momoan-sync-recovery-${sanitizeDbName(vaultId)}`,
			version: DB_VERSION,
			onUpgrade: (db) => {
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME, { keyPath: "id" });
				}
			},
		});
	}

	async put(entry: RecoveryJournalEntry): Promise<void> {
		await this.helper.runTransaction(STORE_NAME, "readwrite", (tx) => {
			tx.objectStore(STORE_NAME).put(entry);
			return () => {};
		});
	}

	async markApplied(id: string, appliedAt: string): Promise<boolean> {
		return this.helper.runTransaction(STORE_NAME, "readwrite", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			const request = store.get(id);
			let changed = false;
			request.onsuccess = () => {
				const current = request.result as RecoveryJournalEntry | undefined;
				if (!current) return;
				store.put({ ...current, disposition: "applied", appliedAt });
				changed = true;
			};
			return () => changed;
		});
	}

	async getAll(): Promise<RecoveryJournalEntry[]> {
		return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
			const request = tx.objectStore(STORE_NAME).getAll();
			return () => request.result as RecoveryJournalEntry[];
		});
	}

	close(): Promise<void> {
		return this.helper.close();
	}
}
