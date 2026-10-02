import { settingsTranslator, type SettingsTranslator } from "./settings-i18n";
import { createFragment, Setting } from "../platform/obsidian";
import type AirSyncPlugin from "../main";
import { getConfigSyncIgnorePatterns } from "../config-sync";

interface ConfigSubtreeSetting {
	key:
		| "syncConfigJsonFiles"
		| "syncConfigPlugins"
		| "syncConfigSnippets"
		| "syncConfigThemes"
		| "syncConfigIcons";
	name: string;
	paths: string[];
	description: string;
}

const CONFIG_SUBTREE_SETTINGS: ConfigSubtreeSetting[] = [
	{
		key: "syncConfigJsonFiles",
		name: "Sync config files",
		paths: ["*.json"],
		description:
			"Sync root JSON config files, excluding the active community plugin list and device-specific workspace state.",
	},
	{
		key: "syncConfigPlugins",
		name: "Sync plugins",
		paths: ["plugins/", "community-plugins.json"],
		description:
			"Sync installed plugins, their settings, and the active community plugin list, excluding Momoan Sync's own data.",
	},
	{
		key: "syncConfigSnippets",
		name: "Sync snippets",
		paths: ["snippets/"],
		description: "Sync CSS snippets.",
	},
	{
		key: "syncConfigThemes",
		name: "Sync themes",
		paths: ["themes/"],
		description: "Sync installed themes.",
	},
	{
		key: "syncConfigIcons",
		name: "Sync icons",
		paths: ["icons/"],
		description: "Sync custom icons.",
	},
];

export function renderConfigSyncSettings(
	containerEl: HTMLElement,
	plugin: AirSyncPlugin,
	rerender: () => void,
): void {
	const t = settingsTranslator(plugin.settings.uiLanguage);
	const configDir = plugin.app.vault.configDir;

	new Setting(containerEl)
		.setName(t("Enable Obsidian config sync"))
		.setDesc(t("Sync Obsidian's own config directory ({dir}/) — hotkeys, plugin settings, and selected portable folders. Device-specific window layout is deliberately excluded. This is Obsidian's internal metadata; syncing it across devices may cause settings loss or plugin malfunction.", { dir: configDir }))
		.addToggle((toggle) =>
			toggle
				.setValue(plugin.settings.enableConfigSync)
				.onChange(async (value) => {
					plugin.settings.enableConfigSync = value;
					await plugin.saveSettings();
					rerender();
				}),
		);

	if (!plugin.settings.enableConfigSync) return;

	for (const option of CONFIG_SUBTREE_SETTINGS) {
		const paths = option.paths.map((path) => `${configDir}/${path}`).join(", ");
		new Setting(containerEl)
			.setName(t(option.name))
			.setDesc(`${t(option.description)} (${paths})`)
			.addToggle((toggle) =>
				toggle
					.setValue(plugin.settings[option.key])
					.onChange(async (value) => {
						plugin.settings[option.key] = value;
						await plugin.saveSettings();
						rerender();
					}),
			);
	}

	renderSyncTiming(containerEl, t);
	renderInjectedPatterns(containerEl, plugin, configDir);
}

function renderSyncTiming(containerEl: HTMLElement, t: SettingsTranslator): void {
	const description = createFragment();
	description.createEl("p", {
		text: t(
			"Config changes aren't synced immediately — they're picked up the next time a sync runs " +
			"(triggered by another vault change, returning to the app, or Sync now)."),
	});
	description.createEl("p", {
		text: t(
			"After a sync finishes, reload the affected plugins, themes, and snippets (or restart Obsidian) " +
			"for the synced settings to take effect."),
	});
	new Setting(containerEl).setName(t("Sync timing")).setDesc(description);
}

function renderInjectedPatterns(
	containerEl: HTMLElement,
	plugin: AirSyncPlugin,
	configDir: string,
): void {
	const t = settingsTranslator(plugin.settings.uiLanguage);
	const description = createFragment();
	description.appendText(t("Added automatically to the top of your Ignore patterns above:"));
	description.createEl("pre", {
		text: getConfigSyncIgnorePatterns(
			plugin.settings,
			configDir,
			plugin.manifest.id,
		).join("\n"),
	});
	new Setting(containerEl).setName(t("Injected ignore patterns")).setDesc(description);
}
