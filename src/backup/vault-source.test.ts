import { describe, expect, it } from "vitest";
import type { DataAdapter, DataAdapterStat } from "../platform/obsidian";
import { VaultBackupSource } from "./vault-source";

class MemoryAdapter implements DataAdapter {
	private readonly files = new Map<string, { content: string; stat: DataAdapterStat }>([
		["note.md", { content: "note", stat: { type: "file", ctime: 1, mtime: 2, size: 4 } }],
		[".hidden-folder/nested/state.json", { content: "{}", stat: { type: "file", ctime: 1, mtime: 3, size: 2 } }],
	]);
	private readonly folders = new Set([".hidden-folder", ".hidden-folder/nested"]);

	exists(path: string): Promise<boolean> { return Promise.resolve(this.files.has(path) || this.folders.has(path)); }
	read(path: string): Promise<string> { return Promise.resolve(this.files.get(path)?.content ?? ""); }
	write(): Promise<void> { return Promise.reject(new Error("read only test adapter")); }
	writeBinary(): Promise<void> { return Promise.reject(new Error("read only test adapter")); }
	mkdir(): Promise<void> { return Promise.reject(new Error("read only test adapter")); }
	remove(): Promise<void> { return Promise.reject(new Error("read only test adapter")); }
	rmdir(): Promise<void> { return Promise.reject(new Error("read only test adapter")); }
	stat(path: string): Promise<DataAdapterStat | null> {
		const file = this.files.get(path);
		if (file) return Promise.resolve(file.stat);
		if (this.folders.has(path)) return Promise.resolve({ type: "folder", ctime: 0, mtime: 0, size: 0 });
		return Promise.resolve(null);
	}
	readBinary(path: string): Promise<ArrayBuffer> {
		const file = this.files.get(path);
		if (!file) return Promise.reject(new Error("missing"));
		return Promise.resolve(new TextEncoder().encode(file.content).buffer);
	}
	list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path ? `${path}/` : "";
		const files = [...this.files.keys()].filter((candidate) =>
			candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"));
		const folders = [...this.folders].filter((candidate) =>
			candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"));
		return Promise.resolve({ files, folders });
	}
}

describe("VaultBackupSource", () => {
	it("captures dot-prefixed Vault content independently of Sync scope", async () => {
		const source = new VaultBackupSource(new MemoryAdapter());

		const paths = (await source.list()).map((entry) => entry.path);

		expect(paths).toContain("note.md");
		expect(paths).toContain(".hidden-folder");
		expect(paths).toContain(".hidden-folder/nested/state.json");
		expect(new TextDecoder().decode(await source.read(".hidden-folder/nested/state.json"))).toBe("{}");
	});
});
