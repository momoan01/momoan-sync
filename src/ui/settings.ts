import { settingsTranslator } from "./settings-i18n";
import { renderSyncModeSettings } from "./sync-mode-settings";
import { syncExecutionMode } from "../settings";
import { shadowPreviewSummary } from "../sync/shadow-preview";
import {
	App,
	Notice,
	Platform,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
} from "../platform/obsidian";
import type AirSyncPlugin from "../main";
import type { ConflictStrategy } from "../sync/types";
import { getBackendProvider } from "../fs/registry";
import { getBackendSettingsRenderer } from "./backend-settings";
import { parseLines } from "../utils/parse-lines";
import { isDotPrefixed } from "../utils/path";
import { renderConfigSyncSettings } from "./config-sync-settings";
import { createBackupRecoveryUiState, renderBackupRecoverySettings } from "./backup-recovery-settings";
import { createRecoveryJournalUiState, renderRecoveryJournalSettings } from "./recovery-journal-settings";

export class AirSyncSettingTab extends PluginSettingTab {
	plugin: AirSyncPlugin;
	private readonly backupRecovery = createBackupRecoveryUiState();
	private readonly recoveryJournal = createRecoveryJournalUiState();

	constructor(app: App, plugin: AirSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Obsidian 1.13+ renders a settings tab from getSettingDefinitions() when it
	// returns a non-empty array; an empty array (the base default) tells it to use
	// the imperative display() below instead — the backward-compat path every
	// pre-1.13 tab relies on. We keep rendering imperatively because the
	// backend-connection section is drawn by each backend's own renderer, which
	// doesn't map onto declarative definitions. Defining this method also
	// satisfies obsidianmd/settings-tab/prefer-setting-definitions.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [];
	}

	display(): void {
		this.renderContent();
	}

	// The imperative renderer. Kept as its own method (not inlined into display())
	// so in-place refreshes can re-render without calling the deprecated display().
	renderContent(): void {
		const { containerEl } = this;
		const t = settingsTranslator(this.plugin.settings.uiLanguage);
		containerEl.empty();
		containerEl.addClass("momoan-sync-settings");
		new Setting(containerEl).setName(t("Momoan Sync")).setHeading();
		new Setting(containerEl).setName(t("Language")).addDropdown(dropdown => dropdown
			.addOption("auto", t("System language")).addOption("ko", "한국어").addOption("en", "English")
			.addOption("ja", "日本語").addOption("zh", "中文").setValue(this.plugin.settings.uiLanguage ?? "auto")
			.onChange(async value => {
				if (value !== "auto" && value !== "ko" && value !== "en" && value !== "ja" && value !== "zh") return;
				this.plugin.settings.uiLanguage = value;
				await this.plugin.saveSettings();
				this.renderContent();
			}));
		new Setting(containerEl).setName(t("Connection")).setHeading();

		// --- Backend-specific settings (config + connection flow) ---
		const provider = getBackendProvider(
			this.plugin.settings.backendType
		);
		const renderer = getBackendSettingsRenderer(
			this.plugin.settings.backendType
		);
		if (renderer) {
			new Setting(containerEl)
				.setName(provider?.displayName ?? "Backend")
				.setHeading().settingEl.addClass("momoan-sync-subheading");

			renderer.render(
				containerEl,
				this.plugin.settings,
				async (updates) => {
					this.plugin.settings.backendData = { ...this.plugin.settings.backendData, ...updates };
					await this.plugin.saveSettings();
					await this.plugin.backendManager.initBackend();
				},
				{
					startAuth: () => this.plugin.backendManager.startBackendConnect(),
					completeAuth: (code: string) =>
						this.plugin.backendManager.completeBackendConnect(code),
					disconnect: () => this.plugin.backendManager.disconnectBackend(),
					refreshDisplay: () => this.renderContent(),
					startFolderPick: () => this.plugin.backendManager.startBackendFolderPick(),
					bindDefaultFolder: () => this.plugin.backendManager.bindDefaultRemoteVault(),
				},
				this.app,
			);
		}

		new Setting(containerEl).setName(t("Sync")).setHeading();
		renderSyncModeSettings(containerEl, this.plugin, () => this.renderContent());
		const shadow = syncExecutionMode(this.plugin.settings) === "shadow";
		if (shadow) {
			new Setting(containerEl).setName(t("Shadow mode · Google Drive"))
				.setDesc(t("No files will be changed."))
				.addButton(button => button.setButtonText(t("Run preview")).onClick(async () => {
					button.setDisabled(true);
					try { await this.plugin.runSync(); } finally { this.renderContent(); }
				}));
			const preview = this.plugin.getLatestShadowPreview();
			if (preview) {
				new Setting(containerEl).setName(t("Latest preview")).setDesc(shadowPreviewSummary(preview).replace(/Create|Update|Rename|Delete|Conflicts/g, label => t(label)));
				new Setting(containerEl).setName(t("Preview diagnostics"))
					.setDesc(t("Blocked") + " " + preview.blockedCount + " · " + t("Admission failures") + " " + preview.admissionFailureCount + ". " + preview.diagnostics.map(item => t(item)).join(" "));
			}
		}

		new Setting(containerEl)
			.setName(t("Conflict strategy"))
			.setDesc(t(
				"Prefer local applies only to conflicts: it uses the local version for proven two-sided edits, " +
				"and automatically preserves both versions when that cannot be proven."
			))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto_merge", t("Auto merge (recommended)"))
					.addOption("prefer_local", t("Prefer local"))
					.addOption("duplicate", t("Always create duplicate"))
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value) => {
						this.plugin.settings.conflictStrategy =
							value as ConflictStrategy;
						await this.plugin.saveSettings();
					})
			);


		new Setting(containerEl).setName(t("Backup and recovery")).setHeading();
		renderBackupRecoverySettings(
			containerEl, this.plugin, this.backupRecovery, () => this.renderContent());
		renderRecoveryJournalSettings(
			containerEl, this.plugin, this.recoveryJournal, () => this.renderContent());

		// --- Advanced settings ---
		new Setting(containerEl).setName(t("Advanced")).setHeading();

		new Setting(containerEl)
			.setName(t(shadow ? "Cold preview" : "Rescan vault"))
			.setDesc(t(
				shadow ? "Run a full observation preview without changing files or the saved checkpoint." : "Discard the remote sync checkpoint and fully reconcile against the remote on the next sync. Use this if sync seems stuck or incomplete after an interrupted sync. It compares files rather than re-downloading them, and keeps your sync history."
			))
			.addButton((button) =>
				button.setButtonText(t(shadow ? "Run cold preview" : "Rescan")).onClick(async () => {
					button.setDisabled(true);
					new Notice(t(shadow ? "Starting a full preview" : "Starting a full rescan"));
					try { await this.plugin.rescan(); } finally { this.renderContent(); }
				})
			);

		new Setting(containerEl)
			.setName(t("Dot-prefixed paths to sync"))
			.setDesc(t(
				"Dot-prefixed folders to include in sync, one per line."
			))
			.addTextArea((text) =>
				text
					.setPlaceholder(".templates\nfoo/.bar")
					.setValue(
						this.plugin.settings.syncDotPaths.join("\n")
					)
					.onChange(async (value) => {
						this.plugin.settings.syncDotPaths = parseLines(value, {
							stripTrailingSlash: true,
							dedupe: true,
						}).filter(isDotPrefixed);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("Ignore patterns"))
			.setDesc(t("Patterns to exclude from sync (gitignore syntax), one per line."))
			.addTextArea((text) =>
				text
					.setValue(
						this.plugin.settings.ignorePatterns.join("\n")
					)
					.onChange(async (value) => {
						// Trailing slashes are meaningful in gitignore (dir-only), so unlike
						// dot paths we deliberately do NOT strip them here.
						this.plugin.settings.ignorePatterns = parseLines(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("Mobile max file size (mb)"))
			.setDesc(t(
				"Files larger than this will be skipped on mobile."
			))
			.addText((text) =>
				text
					.setPlaceholder("10")
					.setValue(
						String(this.plugin.settings.mobileMaxFileSizeMB)
					)
					.onChange(async (value) => {
						const num = parseFloat(value);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.mobileMaxFileSizeMB = num;
							await this.plugin.saveSettings();
						}
					})
			);

		if (Platform.isMobile) {
			new Setting(containerEl)
				.setName(t("Keep screen awake during sync"))
				.setDesc(t(
					"On mobile, prevent the screen from sleeping while a sync is running, so long syncs are not interrupted by the device locking."
				))
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.screenWakeLockOnSync)
						.onChange(async (value) => {
							this.plugin.settings.screenWakeLockOnSync = value;
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName(t("Show sync notifications"))
			.setDesc(t(
				"Show a brief notice summarizing each completed sync (files uploaded, downloaded, etc.)."
			))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showSyncNotifications)
					.onChange(async (value) => {
						this.plugin.settings.showSyncNotifications = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("Enable logging"))
			.setDesc(t(
				"Write sync logs inside the private data directory for debugging."
			))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableLogging)
					.onChange(async (value) => {
						this.plugin.settings.enableLogging = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("Log level"))
			.setDesc(t(
				"Minimum level of messages to log."
			))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("debug", t("Debug"))
					.addOption("info", t("Info"))
					.addOption("warn", t("Warn"))
					.addOption("error", t("Error"))
					.setValue(this.plugin.settings.logLevel)
					.onChange(async (value) => {
						this.plugin.settings.logLevel =
							value as "debug" | "info" | "warn" | "error";
						await this.plugin.saveSettings();
					})
			);

		// --- Experimental settings ---
		new Setting(containerEl).setName(t("Danger zone")).setHeading();

		renderConfigSyncSettings(containerEl, this.plugin, () => this.renderContent());
	}
}
