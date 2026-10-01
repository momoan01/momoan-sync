import type { FileEntity } from "../fs/types";

/** Read-only source contract for whole-Vault snapshots, independent of Sync scope. */
export interface BackupSource {
	list(): Promise<FileEntity[]>;
	stat(path: string): Promise<FileEntity | null>;
	read(path: string): Promise<ArrayBuffer>;
}
