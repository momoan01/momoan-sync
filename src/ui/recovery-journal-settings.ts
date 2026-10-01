import { errorMessage } from "../backend-api";
import type AirSyncPlugin from "../main";
import { Notice, Platform, Setting } from "../platform/obsidian";
import {
	listRecoveryJournalEntries,
	restoreRecoveryJournalEntry,
	type RecoveryJournalEntrySummary,
} from "../recovery/user-recovery";

export interface RecoveryJournalUiState {
	entries: readonly RecoveryJournalEntrySummary[];
	selectedEndpointKey: string;
	restoreDirectory: string;
	status: string;
}

interface RecoveryJournalChoice {
	readonly key: string;
	readonly entryId: string;
	readonly endpointIndex: number;
	readonly label: string;
}

export function createRecoveryJournalUiState(): RecoveryJournalUiState {
	return {
		entries: [],
		selectedEndpointKey: "",
		restoreDirectory: "",
		status: "",
	};
}

export function renderRecoveryJournalSettings(
	containerEl: HTMLElement,
	plugin: AirSyncPlugin,
	state: RecoveryJournalUiState,
	rerender: () => void,
): void {
	new Setting(containerEl).setName("Recent sync recovery").setHeading();
	new Setting(containerEl)
		.setName("Safety journal")
		.setDesc("Captured file states from before destructive sync actions. Restoring exports a copy and never replays the sync action.")
		.addButton((button) => button
			.setButtonText("Refresh journal")
			.onClick(async () => {
				button.setDisabled(true);
				await refreshJournal(plugin, state);
				rerender();
			}));

	const choices = recoveryChoices(state.entries);
	new Setting(containerEl)
		.setName("Captured file")
		.setDesc(choices.length > 0
			? "Choose a captured file state to export for inspection."
			: "Refresh the safety journal to load recoverable file states.")
		.addDropdown((dropdown) => {
			for (const choice of choices) dropdown.addOption(choice.key, choice.label);
			if (state.selectedEndpointKey) dropdown.setValue(state.selectedEndpointKey);
			dropdown.setDisabled(choices.length === 0).onChange((value) => {
				state.selectedEndpointKey = value;
				state.status = "";
			});
		});

	if (Platform.isMobile) {
		new Setting(containerEl)
			.setName("Recovery export")
			.setDesc("Safety journal data remains available on mobile, but exporting captured files requires desktop.");
		if (state.status) new Setting(containerEl).setName("Recovery status").setDesc(state.status);
		return;
	}

	new Setting(containerEl)
		.setName("Restore folder")
		.setDesc("Existing absolute folder outside the vault. The captured file is exported into a new recovery tree.")
		.addText((text) => text
			.setPlaceholder("Absolute restore folder path")
			.setValue(state.restoreDirectory)
			.onChange((value) => { state.restoreDirectory = value; }));

	new Setting(containerEl)
		.setName("Restore captured file")
		.setDesc("Export the selected pre-sync file state without modifying the current vault.")
		.addButton((button) => button
			.setButtonText("Restore captured file")
			.setDisabled(!selectedChoice(state, choices) || !state.restoreDirectory.trim())
			.onClick(async () => {
				button.setDisabled(true);
				await restoreSelectedEntry(plugin, state, choices);
				rerender();
			}));

	if (state.status) new Setting(containerEl).setName("Recovery status").setDesc(state.status);
}

async function refreshJournal(plugin: AirSyncPlugin, state: RecoveryJournalUiState): Promise<void> {
	try {
		state.entries = await listRecoveryJournalEntries(plugin.settings.vaultId);
		const choices = recoveryChoices(state.entries);
		if (!choices.some((choice) => choice.key === state.selectedEndpointKey)) {
			state.selectedEndpointKey = choices[0]?.key ?? "";
		}
		state.status = choices.length === 0
			? "No recoverable file content is currently stored in the safety journal."
			: `Loaded ${choices.length} recoverable file state${choices.length === 1 ? "" : "s"}.`;
	} catch (error) {
		state.entries = [];
		state.selectedEndpointKey = "";
		reportFailure(state, "Could not load the safety journal", error);
	}
}

async function restoreSelectedEntry(
	plugin: AirSyncPlugin,
	state: RecoveryJournalUiState,
	choices: readonly RecoveryJournalChoice[],
): Promise<void> {
	try {
		const choice = selectedChoice(state, choices);
		if (!choice) throw new Error("Choose a captured file first");
		const vaultBasePath = plugin.app.vault.adapter.getBasePath?.();
		if (!vaultBasePath) throw new Error("Vault filesystem path is unavailable");
		const result = await restoreRecoveryJournalEntry({
			vaultId: plugin.settings.vaultId,
			entryId: choice.entryId,
			endpointIndex: choice.endpointIndex,
			vaultBasePath,
			backupDirectory: plugin.settings.backupDirectory,
			restoreDirectory: state.restoreDirectory,
		});
		state.status = `Restored captured file to ${result.restoredPath}.`;
		new Notice("Safety journal recovery exported");
	} catch (error) {
		reportFailure(state, "Could not restore captured file", error);
	}
}

function recoveryChoices(entries: readonly RecoveryJournalEntrySummary[]): RecoveryJournalChoice[] {
	const choices: RecoveryJournalChoice[] = [];
	for (const entry of entries) {
		for (const endpoint of entry.endpoints) {
			if (!endpoint.hasContent) continue;
			choices.push({
				key: `${entry.id}:${endpoint.index}`,
				entryId: entry.id,
				endpointIndex: endpoint.index,
				label: `${new Date(entry.capturedAt).toLocaleString()} · ${formatAction(entry.actionType)} · ${endpoint.side} · ${endpoint.path}`,
			});
		}
	}
	return choices;
}

function selectedChoice(
	state: RecoveryJournalUiState,
	choices: readonly RecoveryJournalChoice[],
): RecoveryJournalChoice | undefined {
	return choices.find((choice) => choice.key === state.selectedEndpointKey);
}

function formatAction(action: string): string {
	return action.replaceAll("_", " ");
}

function reportFailure(state: RecoveryJournalUiState, prefix: string, error: unknown): void {
	state.status = `${prefix}: ${errorMessage(error)}`;
	new Notice(state.status);
}
