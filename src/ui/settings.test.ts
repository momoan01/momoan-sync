import { createShadowPreview } from "../sync/shadow-preview";
import { admitBatchObservation } from "../sync/plan-admission";
import { captureBatchObservation } from "../sync/sync-cycle-planning";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Setting, __ui } from "../__mocks__/obsidian";
import { DEFAULT_SETTINGS } from "../settings";
import type AirSyncPlugin from "../main";
import type { App as ObsidianApp } from "../platform/obsidian";
import { AirSyncSettingTab } from "./settings";

beforeEach(() => {
 __ui.buttons = []; __ui.dropdowns = [];
 vi.stubGlobal("document", { createElement: () => ({ empty: () => {} }) });
});

function pluginFixture() {
	return {
		app: { vault: { configDir: "config-dir" } },
		manifest: { id: "air-sync" },
		settings: { ...DEFAULT_SETTINGS },
		saveSettings: vi.fn().mockResolvedValue(undefined),
		rescan: vi.fn(),
		getLatestShadowPreview: () => null,
		runSync: vi.fn().mockResolvedValue(undefined),
		backendManager: {},
	};
}

describe("AirSyncSettingTab conflict strategy", () => {
	beforeEach(() => {
		__ui.dropdowns = [];
		__ui.buttons = [];
		vi.stubGlobal("document", {
			createElement: () => ({ empty: () => {} }),
		});
	});

	it("renders the safety explanation and strategies in policy order, then saves Prefer local", async () => {
		const plugin = pluginFixture();
		const tab = new AirSyncSettingTab(
			new App() as unknown as ObsidianApp,
			plugin as unknown as AirSyncPlugin,
		);

		tab.display();
		const dropdown = __ui.dropdowns.find((item) => item.name === "Conflict strategy");

		expect(plugin.settings.backendType).toBe("googledrive");
		expect(__ui.dropdowns.some((item) => item.name === "Remote backend")).toBe(false);
		expect(dropdown?.description).toContain("Prefer local applies only to conflicts");
		expect(dropdown?.description).toContain("proven two-sided edits");
		expect(dropdown?.description).toContain("preserves both versions");
		expect(dropdown?.options.map(({ value }) => value)).toEqual([
			"auto_merge", "prefer_local", "duplicate",
		]);
		await dropdown?.change("prefer_local");
		expect(plugin.settings.conflictStrategy).toBe("prefer_local");
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});
});


describe("M3 Shadow settings", () => {
 it("exposes preview and cold preview without a Write mode control", () => {
  const plugin = pluginFixture(); const tab = new AirSyncSettingTab(new App() as unknown as ObsidianApp, plugin as unknown as AirSyncPlugin);
  tab.display();
  const button = __ui.buttons.find(item => item.name === "Shadow mode · Google Drive");
  expect(button?.label).toBe("Run preview");
  expect(__ui.buttons.some(item => item.label === "Run cold preview")).toBe(true);
  expect(__ui.dropdowns.some(item => /mode|backend/i.test(item.name))).toBe(false);
  button?.click(); expect(plugin.runSync).toHaveBeenCalledOnce();
 });
});


it("shows the latest preview summary and explicit no-change disclosure", () => {
 const report = createShadowPreview(admitBatchObservation(captureBatchObservation([], [], [], { byEndpoint: new Map(), isConfiguredScopeCompatible: () => true }, "root")), true, true);
 const plugin = { ...pluginFixture(), getLatestShadowPreview: () => report };
 const names = vi.spyOn(Setting.prototype, "setName"); const descriptions = vi.spyOn(Setting.prototype, "setDesc");
 const tab = new AirSyncSettingTab(new App() as unknown as ObsidianApp, plugin as unknown as AirSyncPlugin); tab.display();
 expect(names).toHaveBeenCalledWith("Latest preview"); expect(descriptions).toHaveBeenCalledWith("No files will be changed.");
 expect(descriptions).toHaveBeenCalledWith("Create 0 · Update 0 · Rename 0 · Delete 0 · Conflicts 0");
 names.mockRestore(); descriptions.mockRestore();
});
