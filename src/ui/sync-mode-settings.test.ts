import { beforeEach, describe, expect, it, vi } from "vitest";
import type AirSyncPlugin from "../main";
import { __ui } from "../__mocks__/obsidian";
import { DEFAULT_SETTINGS } from "../settings";
import { remoteFolderLabel, renderSyncModeSettings, WriteModeConfirmation } from "./sync-mode-settings";
import { resolveSettingsLanguage, settingsTranslator } from "./settings-i18n";

function fixture() {
	return {
		app: {},
		settings: { ...DEFAULT_SETTINGS, backendData: { remoteVaultFolderId: "folder-id", remoteVaultFolderName: "My folder" } },
		saveSettings: vi.fn().mockResolvedValue(undefined),
		isSyncing: vi.fn().mockReturnValue(false),
		runSync: vi.fn(),
	};
}

beforeEach(() => { __ui.buttons = []; __ui.texts = []; });
const asPlugin = (plugin: ReturnType<typeof fixture>) => plugin as unknown as AirSyncPlugin;

describe("explicit Shadow → Write consent", () => {
	it("keeps Shadow as the default; opening or cancelling cannot write or sync", () => {
		const plugin = fixture();
		expect(plugin.settings.syncMode).toBe("shadow");
		expect(remoteFolderLabel(plugin.settings)).toBe("My folder · folder-id");
		const modal = new WriteModeConfirmation(asPlugin(plugin), vi.fn());
		modal.open();
		__ui.buttons.find(button => button.label === "Cancel")?.click();
		expect(plugin.settings.syncMode).toBe("shadow");
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.runSync).not.toHaveBeenCalled();
	});

	it("requires exact WRITE and saves once without executing provider mutations", async () => {
		const plugin = fixture();
		new WriteModeConfirmation(asPlugin(plugin), vi.fn()).open();
		const confirm = __ui.buttons.find(button => button.label === "Enable Write mode");
		await Promise.resolve(confirm?.click());
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		const input = __ui.texts.find(text => text.name === "Type WRITE to confirm");
		await input?.change("write"); await Promise.resolve(confirm?.click());
		expect(plugin.settings.syncMode).toBe("shadow");
		await input?.change("WRITE"); await Promise.resolve(confirm?.click());
		expect(plugin.settings.syncMode).toBe("write");
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		expect(plugin.runSync).not.toHaveBeenCalled();
	});

	it.each(["folder", "backend", "vault", "mode"])("rejects a changed %s during confirmation", async change => {
		const plugin = fixture();
		new WriteModeConfirmation(asPlugin(plugin), vi.fn()).open();
		await __ui.texts.find(text => text.name === "Type WRITE to confirm")?.change("WRITE");
		if (change === "folder") plugin.settings.backendData.remoteVaultFolderId = "other-folder";
		if (change === "backend") plugin.settings.backendType = "other-backend";
		if (change === "vault") plugin.settings.vaultId = "other-vault";
		if (change === "mode") plugin.settings.syncMode = "write";
		await Promise.resolve(__ui.buttons.find(button => button.label === "Enable Write mode")?.click());
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.runSync).not.toHaveBeenCalled();
	});

	it("refuses an unbound folder even if the disabled entry point is invoked", async () => {
		const plugin = fixture(); plugin.settings.backendData.remoteVaultFolderId = "";
		renderSyncModeSettings({} as HTMLElement, asPlugin(plugin), vi.fn());
		await Promise.resolve(__ui.buttons[0]?.click());
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.settings.syncMode).toBe("shadow");
	});

	it("returns to Shadow in one action without running a sync", async () => {
		const plugin = fixture(); plugin.settings.syncMode = "write";
		renderSyncModeSettings({} as HTMLElement, asPlugin(plugin), vi.fn());
		await Promise.resolve(__ui.buttons.find(button => button.label === "Return to Shadow")?.click());
		expect(plugin.settings.syncMode).toBe("shadow");
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		expect(plugin.runSync).not.toHaveBeenCalled();
	});

	it("cannot switch modes during a running sync, including from an already-open dialog", async () => {
		const plugin = fixture();
		new WriteModeConfirmation(asPlugin(plugin), vi.fn()).open();
		await __ui.texts.find(text => text.name === "Type WRITE to confirm")?.change("WRITE");
		plugin.isSyncing.mockReturnValue(true);
		await Promise.resolve(__ui.buttons.find(button => button.label === "Enable Write mode")?.click());
		expect(plugin.settings.syncMode).toBe("shadow");
		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});

	it("returns to fail-closed Shadow if persistence fails", async () => {
		const plugin = fixture(); plugin.saveSettings.mockRejectedValue(new Error("disk unavailable"));
		new WriteModeConfirmation(asPlugin(plugin), vi.fn()).open();
		await __ui.texts.find(text => text.name === "Type WRITE to confirm")?.change("WRITE");
		await expect(__ui.buttons.find(button => button.label === "Enable Write mode")?.click()).rejects.toThrow("disk unavailable");
		expect(plugin.settings.syncMode).toBe("shadow");
	});
});

it.each(["ko", "ja", "zh"])("translates safety warning and settings sections in %s", language => {
	const t = settingsTranslator(language);
	for (const label of ["Connection", "Sync", "Backup and recovery", "Advanced", "Danger zone", "Type WRITE to confirm"]) {
		expect(t(label)).not.toBe(label);
	}
	expect(t("Write can create, update, rename, and delete files in this vault and the selected remote folder. Review the folder and a Shadow preview first. This does not start a sync.")).not.toMatch(/^Write can/);
	expect(t("folder-id")).toBe("folder-id");
});

it("resolves regional language tags and safely falls back to English", () => {
	expect(resolveSettingsLanguage("zh-TW")).toBe("zh");
	expect(resolveSettingsLanguage("ko-KR")).toBe("ko");
	expect(resolveSettingsLanguage("unknown")).toBe("en");
});
