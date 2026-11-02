import { getBackendProvider } from "../fs/registry";
import { Notice, Setting } from "../platform/obsidian";
import type { IBackendSettingsRenderer } from "../fs/settings-renderer";
import { parseGoogleFolderId } from "./google-folder-id";

export function getBackendSettingsRenderer(type: string): IBackendSettingsRenderer | undefined {
	const provider = getBackendProvider(type);
	const original = provider?.createSettingsRenderer?.();
	if (!provider || !original || type !== "googledrive") return original;
	return {
		backendType: original.backendType,
		render(container, settings, onSave, actions, app) {
			original.render(container, settings, onSave, actions, app);
			if (!provider.hasCredentials() || provider.getIdentity(settings)) return;
			let entered = "";
			new Setting(container).setName("Drive 폴더 ID")
				.addText((text) => text.onChange((value) => { entered = value; }))
				.addButton((button) => button.setButtonText("폴더 연결").onClick(async () => {
					try {
						const id = parseGoogleFolderId(entered);
						settings.syncMode = "shadow";
						await onSave({ remoteVaultFolderId: id });
						actions.refreshDisplay();
					} catch (error) {
						new Notice(error instanceof Error ? error.message : "Folder not configured");
					}
				}));
		},
	};
}
