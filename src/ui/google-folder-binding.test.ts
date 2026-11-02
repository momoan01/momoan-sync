import { expect, it, vi } from "vitest";
import { __ui } from "../__mocks__/obsidian";
import { getBackendProvider } from "../fs/registry";
import { getBackendSettingsRenderer } from "./backend-settings";
import { mockSettings } from "../__mocks__/sync-test-helpers";
vi.mock("obsidian");
vi.mock("../fs/registry", () => ({ getBackendProvider: vi.fn() }));

it("binds an existing Google folder in Shadow mode", async () => {
	__ui.buttons = []; __ui.texts = []; __ui.notices = [];
	vi.mocked(getBackendProvider).mockReturnValue({
		createSettingsRenderer: () => ({ backendType: "googledrive", render: vi.fn() }),
		hasCredentials: () => true, getIdentity: () => null,
	} as never);
	const settings = mockSettings({ backendType: "googledrive", syncMode: "write" });
	const save = vi.fn().mockResolvedValue(undefined);
	const refreshDisplay = vi.fn();
	getBackendSettingsRenderer("googledrive")!.render({} as never, settings, save,
		{ refreshDisplay } as never, {} as never);
	__ui.texts.find((x) => x.name === "Drive 폴더 ID")!.change("18ZEdm2CDbX2avMKqomXc-mXd8cLsFXeN");
	await __ui.buttons.find((x) => x.label === "폴더 연결")!.click();
	expect(save).toHaveBeenCalledWith({ remoteVaultFolderId: "18ZEdm2CDbX2avMKqomXc-mXd8cLsFXeN" });
	expect(settings.syncMode).toBe("shadow");
	expect(refreshDisplay).toHaveBeenCalledOnce();
});
