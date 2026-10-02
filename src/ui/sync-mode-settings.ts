import type AirSyncPlugin from "../main";
import { Modal, Notice, Setting, type ButtonComponent } from "../platform/obsidian";
import { syncExecutionMode, type AirSyncSettings } from "../settings";
import { settingsTranslator } from "./settings-i18n";

export function remoteFolderLabel(settings: AirSyncSettings): string {
	const id = settings.backendData.remoteVaultFolderId;
	const name = settings.backendData.remoteVaultFolderName;
	return typeof id === "string" && id.trim() ?
		(typeof name === "string" && name ? `${name} · ${id}` : id) : "";
}

// Capture only non-secret target identity. A pending confirmation cannot authorize
// a different folder, backend or Vault selected while the dialog was open.
function targetIdentity(settings: AirSyncSettings): string {
	return JSON.stringify([settings.vaultId, settings.backendType, settings.backendData.remoteVaultFolderId]);
}

export class WriteModeConfirmation extends Modal {
	private readonly identity: string;
	private readonly folder: string;

	constructor(private readonly plugin: AirSyncPlugin, private readonly rerender: () => void) {
		super(plugin.app);
		this.identity = targetIdentity(plugin.settings);
		this.folder = remoteFolderLabel(plugin.settings);
	}

	onOpen(): void {
		const t = settingsTranslator(this.plugin.settings.uiLanguage);
		this.setTitle(t("Enable Write mode"));
		this.contentEl.addClass("momoan-sync-write-confirmation");
		new Setting(this.contentEl).setName(t("Remote folder")).setDesc(this.folder);
		new Setting(this.contentEl).setName(t("Execution mode")).setDesc(t("Shadow — preview only"));
		new Setting(this.contentEl).setDesc(t("Write can create, update, rename, and delete files in this vault and the selected remote folder. Review the folder and a Shadow preview first. This does not start a sync."));
		let confirmation = "";
		let confirmButton: ButtonComponent | undefined;
		new Setting(this.contentEl).setName(t("Type WRITE to confirm")).addText(text =>
			text.setPlaceholder("WRITE").onChange(value => {
				confirmation = value;
				confirmButton?.setDisabled(value !== "WRITE");
			}));
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText(t("Cancel")).onClick(() => this.close()))
			.addButton(button => {
				confirmButton = button.setButtonText(t("Enable Write mode")).setDisabled(true);
				button.onClick(async () => {
					if (confirmation !== "WRITE" || !this.folder || this.plugin.isSyncing()) return;
					if (this.identity !== targetIdentity(this.plugin.settings) || syncExecutionMode(this.plugin.settings) !== "shadow") {
						new Notice(t("The remote folder or mode changed. Review it again."));
						this.close();
						return;
					}
					button.setDisabled(true);
					this.plugin.settings.syncMode = "write";
					try { await this.plugin.saveSettings(); }
					catch (error) { this.plugin.settings.syncMode = "shadow"; throw error; }
					this.close();
					this.rerender();
				});
			});
	}
}

export function renderSyncModeSettings(container: HTMLElement, plugin: AirSyncPlugin, rerender: () => void): void {
	const t = settingsTranslator(plugin.settings.uiLanguage);
	const shadow = syncExecutionMode(plugin.settings) === "shadow";
	const folder = remoteFolderLabel(plugin.settings);
	new Setting(container).setName(t("Remote folder")).setDesc(folder || t("No folder selected"));
	new Setting(container).setName(t("Execution mode"))
		.setDesc(t(shadow ? "Shadow — preview only" : "Write — file changes enabled"))
		.addButton(button => button.setButtonText(t(shadow ? "Review Write mode" : "Return to Shadow"))
			.setDisabled(plugin.isSyncing() || (shadow && !folder)).onClick(async () => {
				if (plugin.isSyncing()) return;
				if (shadow) {
					if (remoteFolderLabel(plugin.settings)) new WriteModeConfirmation(plugin, rerender).open();
					return;
				}
				plugin.settings.syncMode = "shadow";
				await plugin.saveSettings();
				rerender();
			}));
}
