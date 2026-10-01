import { errorMessage } from "../backend-api";
import type { BackupRestoreSelection, BackupSnapshotSummary } from "../backup/types";
import type AirSyncPlugin from "../main";
import { Notice, Platform, Setting } from "../platform/obsidian";

export interface BackupRecoveryUiState {
	snapshots: readonly BackupSnapshotSummary[];
	selectedSnapshotId: string;
	restoreDirectory: string;
	selectionKind: BackupRestoreSelection["kind"];
	selectionPath: string;
	status: string;
}

export function createBackupRecoveryUiState(): BackupRecoveryUiState {
	return {
		snapshots: [],
		selectedSnapshotId: "",
		restoreDirectory: "",
		selectionKind: "all",
		selectionPath: "",
		status: "",
	};
}

export function renderBackupRecoverySettings(
	containerEl: HTMLElement,
	plugin: AirSyncPlugin,
	state: BackupRecoveryUiState,
	rerender: () => void,
): void {
	new Setting(containerEl).setName("Backup").setHeading();
	if (Platform.isMobile) {
		new Setting(containerEl)
			.setName("Local snapshots")
			.setDesc("Local vault snapshots are desktop-only. File recovery, safety journal, and drive trash remain available on mobile.");
		return;
	}

	new Setting(containerEl)
		.setName("Backup folder")
		.setDesc("Existing absolute folder outside this vault. Momoan sync will create blobs, manifests, and metadata inside it.")
		.addText((text) => text
			.setPlaceholder("Absolute folder path")
			.setValue(plugin.settings.backupDirectory)
			.onChange(async (value) => {
				plugin.settings.backupDirectory = value;
				await plugin.saveSettings();
			}));
	new Setting(containerEl)
		.setName("Local snapshot")
		.setDesc(plugin.settings.backupDirectory
			? "Create a content-addressed snapshot of the whole vault now."
			: "Choose an external backup folder first.")
		.addButton((button) => button
			.setButtonText("Backup now")
			.setDisabled(!plugin.settings.backupDirectory.trim())
			.onClick(async () => {
				button.setDisabled(true);
				try { await plugin.backupNow(); } finally { rerender(); }
			}));

	new Setting(containerEl).setName("Recovery").setHeading();
	new Setting(containerEl)
		.setName("Snapshots")
		.setDesc(snapshotListDescription(state.snapshots))
		.addButton((button) => button
			.setButtonText("Refresh snapshots")
			.setDisabled(!plugin.settings.backupDirectory.trim())
			.onClick(async () => {
				button.setDisabled(true);
				await refreshSnapshots(plugin, state);
				rerender();
			}));

	const hasSnapshots = state.snapshots.length > 0;
	new Setting(containerEl)
		.setName("Snapshot")
		.setDesc(hasSnapshots ? "Choose a completed snapshot from the current vault." : "Refresh snapshots to load recovery points.")
		.addDropdown((dropdown) => {
			for (const snapshot of state.snapshots) {
				dropdown.addOption(snapshot.snapshotId, snapshotLabel(snapshot));
			}
			if (state.selectedSnapshotId) dropdown.setValue(state.selectedSnapshotId);
			dropdown.setDisabled(!hasSnapshots).onChange((value) => {
				state.selectedSnapshotId = value;
				state.status = "";
			});
		});

	new Setting(containerEl)
		.setName("Snapshot integrity")
		.setDesc(state.selectedSnapshotId ? "Verify the manifest and every referenced blob." : "Choose a snapshot first.")
		.addButton((button) => button
			.setButtonText("Verify snapshot")
			.setDisabled(!state.selectedSnapshotId)
			.onClick(async () => {
				button.setDisabled(true);
				await verifySelectedSnapshot(plugin, state);
				rerender();
			}));

	new Setting(containerEl)
		.setName("Restore folder")
		.setDesc("Existing absolute folder outside both the vault and backup store. The original vault is never overwritten.")
		.addText((text) => text
			.setPlaceholder("Absolute restore folder path")
			.setValue(state.restoreDirectory)
			.onChange((value) => { state.restoreDirectory = value; }));

	new Setting(containerEl)
		.setName("Restore scope")
		.setDesc("Restore the entire snapshot, one file, or one folder tree.")
		.addDropdown((dropdown) => dropdown
			.addOption("all", "Entire snapshot")
			.addOption("file", "Single file")
			.addOption("folder", "Folder")
			.setValue(state.selectionKind)
			.setDisabled(!hasSnapshots)
			.onChange((value) => {
				state.selectionKind = value as BackupRestoreSelection["kind"];
				state.selectionPath = "";
				rerender();
			}));

	if (state.selectionKind !== "all") {
		new Setting(containerEl)
			.setName("Snapshot path")
			.setDesc(state.selectionKind === "file" ? "Exact file path inside the snapshot." : "Exact folder path inside the snapshot.")
			.addText((text) => text
				.setPlaceholder(state.selectionKind === "file" ? "folder/note.md" : "folder/subfolder")
				.setValue(state.selectionPath)
				.onChange((value) => { state.selectionPath = value; }));
	}

	new Setting(containerEl)
		.setName("Restore snapshot")
		.setDesc("Materialize the selected data into a new restore tree for inspection.")
		.addButton((button) => button
			.setButtonText("Restore snapshot")
			.setDisabled(!canRestore(state))
			.onClick(async () => {
				button.setDisabled(true);
				await restoreSelectedSnapshot(plugin, state);
				rerender();
			}));

	if (state.status) {
		new Setting(containerEl).setName("Recovery status").setDesc(state.status);
	}
}

async function refreshSnapshots(plugin: AirSyncPlugin, state: BackupRecoveryUiState): Promise<void> {
	try {
		state.snapshots = await plugin.backupService.listSnapshots();
		if (!state.snapshots.some((snapshot) => snapshot.snapshotId === state.selectedSnapshotId)) {
			state.selectedSnapshotId = state.snapshots[0]?.snapshotId ?? "";
		}
		state.status = state.snapshots.length === 0
			? "No completed snapshots found."
			: `Loaded ${state.snapshots.length} completed snapshot${state.snapshots.length === 1 ? "" : "s"}.`;
	} catch (error) {
		state.snapshots = [];
		state.selectedSnapshotId = "";
		reportFailure(state, "Could not load snapshots", error);
	}
}

async function verifySelectedSnapshot(plugin: AirSyncPlugin, state: BackupRecoveryUiState): Promise<void> {
	try {
		const integrity = await plugin.backupService.verifySnapshot(state.selectedSnapshotId);
		state.status = integrity.ok
			? "Snapshot integrity verified."
			: `Snapshot integrity failed · missing ${integrity.missingBlobs.length} · corrupt ${integrity.corruptBlobs.length}.`;
		new Notice(state.status);
	} catch (error) {
		reportFailure(state, "Could not verify snapshot", error);
	}
}

async function restoreSelectedSnapshot(plugin: AirSyncPlugin, state: BackupRecoveryUiState): Promise<void> {
	try {
		const result = await plugin.backupService.restoreSnapshot(
			state.selectedSnapshotId, state.restoreDirectory, restoreSelection(state));
		state.status = `Restored ${result.restoredFiles} files to ${result.targetDirectory}.`;
		new Notice(`Restore complete · ${result.restoredFiles} files`);
	} catch (error) {
		reportFailure(state, "Could not restore snapshot", error);
	}
}

function restoreSelection(state: BackupRecoveryUiState): BackupRestoreSelection {
	if (state.selectionKind === "all") return { kind: "all" };
	const path = state.selectionPath.trim();
	if (!path) throw new Error("Choose a snapshot path first");
	return { kind: state.selectionKind, path };
}

function canRestore(state: BackupRecoveryUiState): boolean {
	return !!state.selectedSnapshotId && !!state.restoreDirectory.trim() &&
		(state.selectionKind === "all" || !!state.selectionPath.trim());
}

function snapshotListDescription(snapshots: readonly BackupSnapshotSummary[]): string {
	const latest = snapshots[0];
	if (!latest) return "Load completed recovery points from the configured backup store.";
	return `${snapshots.length} snapshots · latest ${snapshotLabel(latest)}.`;
}

function snapshotLabel(snapshot: BackupSnapshotSummary): string {
	return `${new Date(snapshot.createdAt).toLocaleString()} · ${snapshot.fileCount} files · ${snapshot.trigger}`;
}

function reportFailure(state: BackupRecoveryUiState, prefix: string, error: unknown): void {
	state.status = `${prefix}: ${errorMessage(error)}`;
	new Notice(state.status);
}
