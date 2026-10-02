export interface IDBOpenConfig {
	dbName: string;
	version: number;
	onUpgrade: (db: IDBDatabase, oldVersion: number) => void;
	/** Opt in only for destructive upgrades of user-relevant durable state. */
	destructiveUpgrade?: { readonly createSnapshot?: () => Promise<unknown> };

}

/** Keep IDB names/messages while rejecting actual Error instances. */
export function normalizeIdbError(error: unknown, fallback: string): Error {
	if (error instanceof Error) return error;
	if (error !== null && typeof error === "object") {
		const normalized = new Error("message" in error && typeof error.message === "string"
			? error.message || fallback : fallback);
		if ("name" in error && typeof error.name === "string") normalized.name = error.name;
		return normalized;
	}
	return new Error(typeof error === "string" || typeof error === "number" ||
		typeof error === "boolean" || typeof error === "bigint" || typeof error === "symbol"
		? String(error) : fallback);
}

export class SchemaMigrationSafetyError extends Error {
	readonly permanent = true;
	readonly permanentCode = "schema_migration_snapshot_failed";
	constructor(message: string) {
		super(message);
		this.name = "SchemaMigrationSafetyError";
	}
}

/**
 * Shared IndexedDB lifecycle helper.
 * Handles open/close idempotency, onversionchange recovery,
 * and transaction boilerplate.
 */
export class IDBHelper {
	private db: IDBDatabase | null = null;
	private openPromise: Promise<void> | null = null;
	private readonly config: IDBOpenConfig;

	constructor(config: IDBOpenConfig) {
		this.config = config;
	}

	async open(): Promise<void> {
		if (this.db) return;
		if (this.openPromise) return this.openPromise;
		this.openPromise = this.doOpen();
		try {
			await this.openPromise;
		} catch (err) {
			this.openPromise = null;
			throw err;
		}
	}

	/**
	 * Unversioned open never upgrades an existing DB. Abort a new-DB probe before
	 * creation commits; no async filesystem operation runs in an upgrade transaction.
	 */
	private preflightVersion(): Promise<number> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.config.dbName);
			let absent = false;
			let blocked = false;
			request.onblocked = () => {
				blocked = true;
				reject(new SchemaMigrationSafetyError("Schema preflight is blocked"));
			};
			request.onupgradeneeded = (event) => {
				absent = event.oldVersion === 0 && !blocked;
				request.transaction!.abort();
			};
			request.onsuccess = () => {
				const version = request.result.version;
				request.result.close();
				if (!blocked) resolve(version);
			};
			request.onerror = () => {
				if (absent) resolve(0);
				else reject(new SchemaMigrationSafetyError(
					"Schema preflight failed: " + (request.error?.message ?? "unknown")));
			};
		});
	}

	private async doOpen(): Promise<void> {
		const { dbName, version, onUpgrade, destructiveUpgrade } = this.config;
		const observedVersion = destructiveUpgrade ? await this.preflightVersion() : undefined;
		if (observedVersion !== undefined && observedVersion > 0 && observedVersion < version) {
			if (!destructiveUpgrade?.createSnapshot) {
				throw new SchemaMigrationSafetyError("Destructive schema migration requires a local snapshot");
			}
			try { await destructiveUpgrade.createSnapshot(); } catch (error) {
				throw new SchemaMigrationSafetyError("Schema migration snapshot failed: " +
					(error instanceof Error ? error.message : String(error)));
			}
		}

		this.db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(dbName, version);
			let abandoned = false;
			let upgradeError: unknown;
			request.onblocked = () => {
				abandoned = true;
				reject(new Error(`IndexedDB "${dbName}" is blocked by another connection`));
			};
			request.onupgradeneeded = (event) => {
				// Proof is attempt-local: another tab may change or remove the DB.
				if (abandoned || (observedVersion !== undefined && event.oldVersion !== observedVersion)) {
					upgradeError = new SchemaMigrationSafetyError("Schema version changed after preflight");
					request.transaction!.abort();
					return;
				}
				try { onUpgrade(request.result, event.oldVersion); } catch (error) {
					upgradeError = error;
					request.transaction!.abort();
				}
			};
			request.onsuccess = () => {
				if (abandoned) request.result.close();
				else resolve(request.result);
			};
			request.onerror = () =>
				reject(normalizeIdbError(upgradeError ?? request.error, "Failed to open IndexedDB: unknown"));
		});
		this.db.onversionchange = () => {
			this.db?.close();
			this.db = null;
			this.openPromise = null;
		};
	}

	async getDb(): Promise<IDBDatabase> {
		await this.open();
		if (!this.db) {
			this.openPromise = null;
			await this.open();
		}
		if (!this.db) {
			throw new Error("IndexedDB unavailable after re-open attempt");
		}
		return this.db;
	}

	/**
	 * Discard the cached connection so the next `getDb()` opens a fresh one.
	 * iOS Safari closes IndexedDB connections out from under us when the app is
	 * backgrounded or under memory pressure; the stale handle then throws
	 * "The database connection is closing" on every transaction until it is
	 * dropped — which is why the plugin previously needed a task-kill to recover.
	 */
	private resetConnection(): void {
		try {
			this.db?.close();
		} catch {
			// already closing/closed — nothing to do
		}
		this.db = null;
		this.openPromise = null;
	}

	async close(): Promise<void> {
		if (this.openPromise) {
			try {
				await this.openPromise;
			} catch {
				// open failed — nothing to close
			}
		}
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		this.openPromise = null;
	}

	/**
	 * Run an IndexedDB transaction with automatic promise wrapping.
	 * `fn` receives the transaction, performs IDB operations, and returns
	 * a thunk `() => T` that is called on `tx.oncomplete` to safely read results.
	 *
	 * `fn` must be idempotent: on a "connection is closing" failure the
	 * transaction is retried once on a fresh connection, so it may run twice.
	 * Every caller here issues only keyed put/get/delete/clear/getAll ops, which
	 * are safe to repeat; read-modify-write counters would not be.
	 */
	async runTransaction<T>(
		storeNames: string | string[],
		mode: IDBTransactionMode,
		fn: (tx: IDBTransaction) => () => T,
	): Promise<T> {
		try {
			return await this.attemptTransaction(storeNames, mode, fn);
		} catch (err) {
			if (!isConnectionClosingError(err)) throw err;
			// The cached connection was closed under us (typically iOS backgrounding
			// the app). Drop it and retry once with a freshly opened connection so the
			// next sync recovers without a task-kill.
			this.resetConnection();
			return this.attemptTransaction(storeNames, mode, fn);
		}
	}

	private async attemptTransaction<T>(
		storeNames: string | string[],
		mode: IDBTransactionMode,
		fn: (tx: IDBTransaction) => () => T,
	): Promise<T> {
		const db = await this.getDb();
		return new Promise<T>((resolve, reject) => {
			let tx: IDBTransaction;
			try {
				tx = db.transaction(storeNames, mode);
			} catch (err) {
				// `transaction()` throws synchronously when the connection is closing;
				// surface it as a rejection so runTransaction can decide to recover.
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			const getResult = fn(tx);
			tx.oncomplete = () => resolve(getResult());
			tx.onerror = () => reject(new IDBTransactionError("error", tx.error));
			tx.onabort = () => reject(new IDBTransactionError("abort", tx.error));
		});
	}
}

/**
 * A failed IndexedDB transaction, surfaced from `tx.onerror`/`tx.onabort`.
 *
 * The browser hands us a {@link DOMException} on `tx.error` whose `name`
 * (`"InvalidStateError"`, `"AbortError"`, `"QuotaExceededError"`, …) is the
 * structured signal callers should classify on — so we preserve it as
 * {@link domName} (and the original exception as `cause`) instead of flattening
 * to a string message that downstream code then has to re-parse.
 */
export class IDBTransactionError extends Error {
	/** Which lifecycle hook fired: `tx.onerror` vs `tx.onabort`. */
	readonly phase: "error" | "abort";
	/** The underlying `DOMException.name`, or `null` when the browser gave us none. */
	readonly domName: string | null;
	/** The original `DOMException`, preserved for callers that want the raw cause. */
	readonly cause?: DOMException;
	constructor(phase: "error" | "abort", domError: DOMException | null) {
		const verb = phase === "error" ? "failed" : "aborted";
		super(`Transaction ${verb}: ${domError?.message ?? "unknown"}`);
		this.name = "IDBTransactionError";
		this.phase = phase;
		this.domName = domError?.name ?? null;
		if (domError) this.cause = domError;
	}
}

/** The `DOMException.name` raised when an IndexedDB connection is closing. */
const CONNECTION_CLOSING_DOM_NAME = "InvalidStateError";

/**
 * Detect the "database connection is closing" failure that iOS Safari raises
 * when it closes an IndexedDB connection out from under us. Covers both the
 * raw `InvalidStateError` thrown synchronously by `transaction()` and the
 * {@link IDBTransactionError} surfaced via `tx.onerror`/`tx.onabort` when the
 * connection dies mid-flight.
 *
 * Classification is by DOMException `name` (`domName` for the wrapped case,
 * `err.name` for the raw throw); the message regex is retained only as a
 * cross-browser fallback for engines that report no usable `name`.
 */
export function isConnectionClosingError(err: unknown): boolean {
	if (err instanceof IDBTransactionError) {
		return err.domName === CONNECTION_CLOSING_DOM_NAME || /connection is closing/i.test(err.message);
	}
	if (!(err instanceof Error)) return false;
	return err.name === CONNECTION_CLOSING_DOM_NAME || /connection is closing/i.test(err.message);
}

export function sanitizeDbName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
