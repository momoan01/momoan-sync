import { settingsTranslator } from "./settings-i18n";
import { normalizeBackupIntervalMinutes } from "../backup/lifecycle";
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
	const t = settingsTranslator(plugin.settings.uiLanguage);
	new Setting(containerEl).setName(t("Backup")).setHeading();
	if (Platform.isMobile) {
		new Setting(containerEl)
			.setName(t("Local snapshots"))
			.setDesc(t("Local vault snapshots are desktop-only. File recovery, safety journal, and drive trash remain available on mobile."));
		return;
	}

	new Setting(containerEl)
		.setName(t("Backup folder"))
		.setDesc(t("Existing absolute folder outside this vault. Momoan sync will create blobs, manifests, and metadata inside it."))
		.addText((text) => text
			.setPlaceholder(t("Absolute folder path"))
			.setValue(plugin.settings.backupDirectory)
			.onChange(async (value) => {
				plugin.settings.backupDirectory = value;
				await plugin.saveSettings();
			}));
	new Setting(containerEl)
		.setName(t("Snapshot interval"))
		.setDesc(t("Minutes between background snapshots. 0 = off. Requires an external backup folder."))
		.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.min = "0";
			text.inputEl.step = "1";
			text.setValue(String(plugin.settings.backupIntervalMinutes)).onChange(async (value) => {
				plugin.settings.backupIntervalMinutes = normalizeBackupIntervalMinutes(Number(value));
				await plugin.saveSettings();
			});
		});
	new Setting(containerEl)
		.setName(t("Local snapshot"))
		.setDesc(t(plugin.settings.backupDirectory ? "Create a content-addressed snapshot of the whole vault now." : "Choose an external backup folder first."))
		.addButton((button) => button
			.setButtonText(t("Backup now"))
			.setDisabled(!plugin.settings.backupDirectory.trim())
			.onClick(async () => {
				button.setDisabled(true);
				try { await plugin.backupNow(); } finally { rerender(); }
			}));

	new Setting(containerEl).setName(t("Recovery")).setHeading();
	new Setting(containerEl)
		.setName(t("Snapshots"))
		.setDesc(snapshotListDescription(state.snapshots, t))
		.addButton((button) => button
			.setButtonText(t("Refresh snapshots"))
			.setDisabled(!plugin.settings.backupDirectory.trim())
			.onClick(async () => {
				button.setDisabled(true);
				await refreshSnapshots(plugin, state);
				rerender();
			}));

	const hasSnapshots = state.snapshots.length > 0;
	new Setting(containerEl)
		.setName(t("Snapshot"))
		.setDesc(t(hasSnapshots ? "Choose a completed snapshot from the current vault." : "Refresh snapshots to load recovery points."))
		.addDropdown((dropdown) => {
			for (const snapshot of state.snapshots) {
				dropdown.addOption(snapshot.snapshotId, snapshotLabel(snapshot, t));
			}
			if (state.selectedSnapshotId) dropdown.setValue(state.selectedSnapshotId);
			dropdown.setDisabled(!hasSnapshots).onChange((value) => {
				state.selectedSnapshotId = value;
				state.status = "";
			});
		});

	new Setting(containerEl)
		.setName(t("Snapshot integrity"))
		.setDesc(t(state.selectedSnapshotId ? "Verify the manifest and every referenced blob." : "Choose a snapshot first."))
		.addButton((button) => button
			.setButtonText(t("Verify snapshot"))
			.setDisabled(!state.selectedSnapshotId)
			.onClick(async () => {
				button.setDisabled(true);
				await verifySelectedSnapshot(plugin, state);
				rerender();
			}));

	new Setting(containerEl)
		.setName(t("Restore folder"))
		.setDesc(t("Existing absolute folder outside both the vault and backup store. The original vault is never overwritten."))
		.addText((text) => text
			.setPlaceholder(t("Absolute restore folder path"))
			.setValue(state.restoreDirectory)
			.onChange((value) => { state.restoreDirectory = value; }));

	new Setting(containerEl)
		.setName(t("Restore scope"))
		.setDesc(t("Restore the entire snapshot, one file, or one folder tree."))
		.addDropdown((dropdown) => dropdown
			.addOption("all", t("Entire snapshot"))
			.addOption("file", t("Single file"))
			.addOption("folder", t("Folder"))
			.setValue(state.selectionKind)
			.setDisabled(!hasSnapshots)
			.onChange((value) => {
				state.selectionKind = value as BackupRestoreSelection["kind"];
				state.selectionPath = "";
				rerender();
			}));

	if (state.selectionKind !== "all") {
		new Setting(containerEl)
			.setName(t("Snapshot path"))
			.setDesc(t(state.selectionKind === "file" ? "Exact file path inside the snapshot." : "Exact folder path inside the snapshot."))
			.addText((text) => text
				.setPlaceholder(state.selectionKind === "file" ? "folder/note.md" : "folder/subfolder")
				.setValue(state.selectionPath)
				.onChange((value) => { state.selectionPath = value; }));
	}

	new Setting(containerEl)
		.setName(t("Restore snapshot"))
		.setDesc(t("Materialize the selected data into a new restore tree for inspection."))
		.addButton((button) => button
			.setButtonText(t("Restore snapshot"))
			.setDisabled(!canRestore(state))
			.onClick(async () => {
				button.setDisabled(true);
				await restoreSelectedSnapshot(plugin, state);
				rerender();
			}));

	if (state.status) {
		new Setting(containerEl).setName(t("Recovery status")).setDesc(state.status);
	}
}

async function refreshSnapshots(plugin: AirSyncPlugin, state: BackupRecoveryUiState): Promise<void> {
	const t = settingsTranslator(plugin.settings.uiLanguage);
	try {
		state.snapshots = await plugin.backupService.listSnapshots();
		if (!state.snapshots.some((snapshot) => snapshot.snapshotId === state.selectedSnapshotId)) {
			state.selectedSnapshotId = state.snapshots[0]?.snapshotId ?? "";
		}
		state.status = state.snapshots.length === 0
			? t("No completed snapshots found.")
			: t("Loaded {n} completed snapshots.", { n: state.snapshots.length });
	} catch (error) {
		state.snapshots = [];
		state.selectedSnapshotId = "";
		reportFailure(state, t("Could not load snapshots"), error);
	}
}

async function verifySelectedSnapshot(plugin: AirSyncPlugin, state: BackupRecoveryUiState): Promise<void> {
	const t = settingsTranslator(plugin.settings.uiLanguage);
	try {
		const integrity = await plugin.backupService.verifySnapshot(state.selectedSnapshotId);
		state.status = integrity.ok
			? t("Snapshot integrity verified.")
			: t("Snapshot integrity failed · missing {missing} · corrupt {corrupt}.", { missing: integrity.missingBlobs.length, corrupt: integrity.corruptBlobs.length });
		new Notice(state.status);
	} catch (error) {
		reportFailure(state, t("Could not verify snapshot"), error);
	}
}

async function restoreSelectedSnapshot(plugin: AirSyncPlugin, state: BackupRecoveryUiState): Promise<void> {
	const t = settingsTranslator(plugin.settings.uiLanguage);
	try {
		const result = await plugin.backupService.restoreSnapshot(
			state.selectedSnapshotId, state.restoreDirectory, restoreSelection(state));
		state.status = t("Restored {n} files to {path}.", { n: result.restoredFiles, path: result.targetDirectory });
		new Notice(t("Restore complete · {n} files", { n: result.restoredFiles }));
	} catch (error) {
		reportFailure(state, t("Could not restore snapshot"), error);
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

function snapshotListDescription(snapshots: readonly BackupSnapshotSummary[], t: import("./settings-i18n").SettingsTranslator): string {
	const latest = snapshots[0];
	if (!latest) return t("Load completed recovery points from the configured backup store.");
	return t("{n} snapshots · latest {latest}.", { n: snapshots.length, latest: snapshotLabel(latest, t) });
}

function snapshotLabel(snapshot: BackupSnapshotSummary, t: import("./settings-i18n").SettingsTranslator): string {
	return `${new Date(snapshot.createdAt).toLocaleString()} · ${t("{n} files", { n: snapshot.fileCount })} · ${snapshot.trigger}`;
}

function reportFailure(state: BackupRecoveryUiState, prefix: string, error: unknown): void {
	state.status = `${prefix}: ${errorMessage(error)}`;
	new Notice(state.status);
}
