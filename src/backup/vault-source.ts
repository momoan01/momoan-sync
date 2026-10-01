import type { FileEntity } from "../fs/types";
import type { DataAdapter } from "../platform/obsidian";
import type { BackupSource } from "./source";

/** Whole-Vault read surface for Backup Engine. It deliberately ignores Sync scope. */
export class VaultBackupSource implements BackupSource {
	constructor(private readonly adapter: DataAdapter) {}

	async list(): Promise<FileEntity[]> {
		const entities: FileEntity[] = [];
		await this.scan("", entities);
		return entities;
	}

	async stat(path: string): Promise<FileEntity | null> {
		const stat = await this.adapter.stat(path);
		if (!stat) return null;
		if (stat.type === "folder") {
			return { path, pathAuthority: "actual_resolved", isDirectory: true, size: 0, mtime: 0, hash: "" };
		}
		return {
			path,
			pathAuthority: "actual_resolved",
			isDirectory: false,
			size: stat.size,
			mtime: stat.mtime,
			hash: "",
		};
	}

	read(path: string): Promise<ArrayBuffer> {
		return this.adapter.readBinary(path);
	}

	private async scan(directory: string, entities: FileEntity[]): Promise<void> {
		const listed = await this.adapter.list(directory);
		for (const folder of [...listed.folders].sort()) {
			const stat = await this.adapter.stat(folder);
			if (!stat || stat.type !== "folder") {
				throw new Error(`Backup source changed during listing: ${folder}`);
			}
			entities.push({ path: folder, pathAuthority: "actual_resolved", isDirectory: true, size: 0, mtime: 0, hash: "" });
			await this.scan(folder, entities);
		}
		for (const file of [...listed.files].sort()) {
			const stat = await this.adapter.stat(file);
			if (!stat || stat.type !== "file") {
				throw new Error(`Backup source changed during listing: ${file}`);
			}
			entities.push({
				path: file,
				pathAuthority: "actual_resolved",
				isDirectory: false,
				size: stat.size,
				mtime: stat.mtime,
				hash: "",
			});
		}
	}
}
