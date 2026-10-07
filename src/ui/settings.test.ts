import { createShadowPreview } from "../sync/shadow-preview";
import { admitBatchObservation } from "../sync/plan-admission";
import { captureBatchObservation } from "../sync/sync-cycle-planning";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Setting, __ui } from "../__mocks__/obsidian";
import { DEFAULT_SETTINGS } from "../settings";
import type AirSyncPlugin from "../main";
import type { App as ObsidianApp } from "../platform/obsidian";
import { AirSyncSettingTab } from "./settings";
import { deferred } from "../__mocks__/sync-test-helpers";

beforeEach(() => {
 __ui.buttons = []; __ui.dropdowns = [];
 vi.stubGlobal("document", { createElement: () => ({ empty: () => {}, addClass: () => {} }) });
});

function pluginFixture() {
	return {
		app: { vault: { configDir: "config-dir" } },
		manifest: { id: "air-sync" },
		settings: { ...DEFAULT_SETTINGS },
		saveSettings: vi.fn().mockResolvedValue(undefined),
		rescan: vi.fn(),
		getLatestShadowPreview: () => null,
		isSyncing: vi.fn().mockReturnValue(false),
		runSync: vi.fn().mockResolvedValue(undefined),
		backendManager: {},
	};
}

describe("AirSyncSettingTab conflict strategy", () => {
	beforeEach(() => {
		__ui.dropdowns = [];
		__ui.buttons = [];
		vi.stubGlobal("document", {
			createElement: () => ({ empty: () => {}, addClass: () => {} }),
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
 it.each(["shadow", "write"] as const)("awaits %s cold observation and refreshes only after completion", async mode => {
  const pending = deferred<void>(); const plugin = pluginFixture(); plugin.settings.syncMode = mode;
  plugin.rescan.mockReturnValue(pending.promise);
  const tab = new AirSyncSettingTab(new App() as unknown as ObsidianApp, plugin as unknown as AirSyncPlugin);
  const display = vi.spyOn(tab, "renderContent"); tab.display();
  const button = __ui.buttons.find(item => item.label === (mode === "shadow" ? "Run cold preview" : "Rescan"));
  if (!button) throw new Error("Missing cold observation button");
  const click = button.click(); expect(button.disabled).toBe(true); button.click();
  expect(plugin.rescan).toHaveBeenCalledOnce(); expect(display).toHaveBeenCalledOnce();
  pending.resolve(); await click;
  expect(display).toHaveBeenCalledTimes(2);
  expect(__ui.buttons.filter(item => item.label === button.label).at(-1)?.disabled).toBe(false);
 });
 it("renders the newly completed cold preview report", async () => {
  const report = createShadowPreview(admitBatchObservation(captureBatchObservation([], [], [], { byEndpoint: new Map(), isConfiguredScopeCompatible: () => true }, "root")), true, true);
  const latest = vi.fn().mockReturnValue(report);
  const pending = deferred<void>();
  const plugin = { ...pluginFixture(), getLatestShadowPreview: latest };
  plugin.rescan.mockImplementation(async () => {
   await pending.promise;
   latest.mockReturnValue({ ...report, expectedChanges: { ...report.expectedChanges, create: { local: 2, remote: 0 } } });
  });
  const descriptions = vi.spyOn(Setting.prototype, "setDesc");
  const tab = new AirSyncSettingTab(new App() as unknown as ObsidianApp, plugin as unknown as AirSyncPlugin);
  tab.display();
  const button = __ui.buttons.find(item => item.label === "Run cold preview");
  if (!button) throw new Error("Missing cold preview button");
  try {
   const click = button.click(); button.click();
   expect(plugin.rescan).toHaveBeenCalledOnce(); expect(button.disabled).toBe(true);
   expect(descriptions).not.toHaveBeenCalledWith("Create 2 · Update 0 · Rename 0 · Delete 0 · Conflicts 0");
   pending.resolve(); await click;
   expect(descriptions).toHaveBeenCalledWith("Create 2 · Update 0 · Rename 0 · Delete 0 · Conflicts 0");
  } finally { descriptions.mockRestore(); }
 });
 it("refreshes cold preview UI in finally after rejection", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const plugin = pluginFixture(); plugin.rescan.mockReturnValue(pending);
  const tab = new AirSyncSettingTab(new App() as unknown as ObsidianApp, plugin as unknown as AirSyncPlugin);
  const display = vi.spyOn(tab, "renderContent"); tab.display();
  const button = __ui.buttons.find(item => item.label === "Run cold preview");
  if (!button) throw new Error("Missing cold preview button");
  const click = button.click(); expect(button.disabled).toBe(true);
  reject(new Error("Preview unavailable")); await expect(click).rejects.toThrow("Preview unavailable");
  expect(display).toHaveBeenCalledTimes(2);
  expect(__ui.buttons.filter(item => item.label === "Run cold preview").at(-1)?.disabled).toBe(false);
 });
 it("exposes preview and cold preview with no ordinary mode toggle", () => {
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

it.each(["ko", "ja", "zh"])("renders all five product sections in %s and persists the language", async language => {
 const plugin = pluginFixture();
 const names = vi.spyOn(Setting.prototype, "setName");
 const tab = new AirSyncSettingTab(new App() as unknown as ObsidianApp, plugin as unknown as AirSyncPlugin);
 tab.display();
 const languageControl = __ui.dropdowns.find(item => item.name === "Language");
 await languageControl?.change(language);
 expect(plugin.settings).toHaveProperty("uiLanguage", language);
 expect(plugin.saveSettings).toHaveBeenCalledOnce();
 const translated = language === "ko" ? ["연결", "동기화", "백업·복구", "고급", "위험 영역"] :
  language === "ja" ? ["接続", "同期", "バックアップ・復元", "詳細", "危険な操作"] : ["连接", "同步", "备份与恢复", "高级", "危险操作"];
 for (const section of translated) expect(names).toHaveBeenCalledWith(section);
 names.mockRestore();
});
