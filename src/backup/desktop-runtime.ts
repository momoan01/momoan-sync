export type AtomicCreateResult = "created" | "exists";

/** Minimal desktop-only filesystem surface used by the external Backup Store. */
export interface DesktopBackupFileOps {
	readonly separator: string;
	isAbsolute(path: string): boolean;
	resolve(path: string): string;
	relative(from: string, to: string): string;
	join(...parts: string[]): string;
	dirname(path: string): string;
	realpath(path: string): Promise<string>;
	isDirectory(path: string): Promise<boolean>;
	ensureDirectory(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	readBinary(path: string): Promise<ArrayBuffer>;
	readText(path: string): Promise<string>;
	listNames(path: string): Promise<string[]>;
	atomicCreate(path: string, content: string | ArrayBuffer): Promise<AtomicCreateResult>;
	remove(path: string): Promise<void>;
}

interface NodeStatsLike {
	isDirectory(): boolean;
}

interface NodeFileHandleLike {
	writeFile(data: string | Uint8Array): Promise<void>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

interface NodeFsPromisesLike {
	stat(path: string): Promise<NodeStatsLike>;
	realpath(path: string): Promise<string>;
	mkdir(path: string, options: { recursive: true }): Promise<unknown>;
	readFile(path: string): Promise<Uint8Array>;
	readFile(path: string, encoding: "utf8"): Promise<string>;
	readdir(path: string): Promise<string[]>;
	open(path: string, flags: "wx"): Promise<NodeFileHandleLike>;
	rename(oldPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

interface NodePathLike {
	readonly sep: string;
	isAbsolute(path: string): boolean;
	resolve(path: string): string;
	relative(from: string, to: string): string;
	join(...parts: string[]): string;
	dirname(path: string): string;
	basename(path: string): string;
}

declare const require: ((specifier: string) => unknown) | undefined;

/** Load a Node builtin only after the caller has gated the operation to desktop. */
function requireDesktopBuiltin<T>(specifier: string): T {
	if (typeof require !== "function") {
		throw new Error("Desktop backup runtime is unavailable");
	}
	return require(specifier) as T;
}

/** Load Node only after the caller has gated the operation to desktop. */
export function createNodeBackupFileOps(): Promise<DesktopBackupFileOps> {
	const fs = requireDesktopBuiltin<NodeFsPromisesLike>("fs/promises");
	const nodePath = requireDesktopBuiltin<NodePathLike>("path");

	const exists = async (path: string): Promise<boolean> => {
		try {
			await fs.stat(path);
			return true;
		} catch (error) {
			if (hasCode(error, "ENOENT")) return false;
			throw error;
		}
	};

	return Promise.resolve({
		separator: nodePath.sep,
		isAbsolute: (path) => nodePath.isAbsolute(path),
		resolve: (path) => nodePath.resolve(path),
		relative: (from, to) => nodePath.relative(from, to),
		join: (...parts) => nodePath.join(...parts),
		dirname: (path) => nodePath.dirname(path),
		realpath: (path) => fs.realpath(path),
		async isDirectory(path) {
			try {
				return (await fs.stat(path)).isDirectory();
			} catch (error) {
				if (hasCode(error, "ENOENT")) return false;
				throw error;
			}
		},
		ensureDirectory: (path) => fs.mkdir(path, { recursive: true }).then(() => undefined),
		exists,
		async readBinary(path) {
			const bytes = await fs.readFile(path);
			const copy = new Uint8Array(bytes.byteLength);
			copy.set(bytes);
			return copy.buffer;
		},
		readText: (path) => fs.readFile(path, "utf8"),
		async listNames(path) {
			try {
				return await fs.readdir(path);
			} catch (error) {
				if (hasCode(error, "ENOENT")) return [];
				throw error;
			}
		},
		async atomicCreate(path, content) {
			if (await exists(path)) return "exists";
			await fs.mkdir(nodePath.dirname(path), { recursive: true });
			const temporary = nodePath.join(
				nodePath.dirname(path),
				`.${nodePath.basename(path)}.${crypto.randomUUID()}.tmp`,
			);
			const handle = await fs.open(temporary, "wx");
			try {
				await handle.writeFile(typeof content === "string" ? content : new Uint8Array(content));
				await handle.sync();
			} finally {
				await handle.close();
			}
			let published = false;
			try {
				if (await exists(path)) return "exists";
				await fs.rename(temporary, path);
				published = true;
				return "created";
			} catch (error) {
				if (await exists(path)) return "exists";
				throw error;
			} finally {
				if (!published) await fs.unlink(temporary).catch(() => undefined);
			}
		},
		async remove(path) {
			try {
				await fs.unlink(path);
			} catch (error) {
				if (!hasCode(error, "ENOENT")) throw error;
			}
		},
	});
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error &&
		(error as { code?: unknown }).code === code;
}
