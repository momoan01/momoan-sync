import { resolveGoogleSecretId } from "../../src/fs/modules/google-secret-ids";
function requireString(value: unknown): string {
	if (typeof value !== "string") throw new Error("Expected string in authorization contract");
	return value;
}

import { describe, expect, it, vi } from "vitest";
import type { BackendHttpResponse, JsonObject, JsonValue } from "../../src/backend-api";
import { googleDriveModule } from "../../src/backends/googledrive/module";
import { createModuleConnection } from "../../src/fs/modules/connection-host";
import { computeS256Challenge } from "../../src/backend-api/oauth-pkce";
import { handleOAuthProtocolCallback } from "../../src/fs/oauth-callback-error";

vi.mock("obsidian");

const CID = "byo-client.apps.googleusercontent.com";
const CS = "device-client-secret";
const TOKEN = { access_token: "DEVICE-ACCESS", refresh_token: "DEVICE-REFRESH", expires_in: 3600 };
const FOLDER = { id: "folder-1", name: "Vault", mimeType: "application/vnd.google-apps.folder" };
const physical = (_id: string, key: string): string => resolveGoogleSecretId(key);

function response(body: JsonValue): BackendHttpResponse {
	const text = JSON.stringify(body);
	return { status: 200, headers: {}, json: () => Promise.resolve(body), text: () => Promise.resolve(text),
		arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer) };
}

function fixture(folder: JsonValue = FOLDER, failOpen = false) {
	let config: JsonObject = { clientId: CID, redirectUri: "https://example.test/callback" };
	const secrets = new Map<string, string>([[physical("googledrive", "clientSecret"), CS]]);
	const opened: string[] = [];
	const sink = vi.fn();
	const connection = createModuleConnection({
		module: googleDriveModule, generation: 1, isCurrentGeneration: () => true,
		secrets: { getSecret: (key) => secrets.get(key) ?? null, setSecret: (key, value) => {
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) throw new Error("Invalid Obsidian SecretStorage ID");
			secrets.set(key, value);
		} },
		resolvePhysicalKey: physical, sink,
		config: { read: () => config, write: (next) => { config = next; return Promise.resolve(); },
			clear: () => { config = googleDriveModule.disconnectConfig!(config); return Promise.resolve(); } },
		openUrl: (url) => { if (failOpen) throw new Error("Browser unavailable"); opened.push(url); },
	});
	const request = vi.spyOn(connection.context.http, "request").mockImplementation((input) =>
		Promise.resolve(response(input.url.includes("/token") ? TOKEN : folder)),
	);
	const value = (key: string) => secrets.get(physical("googledrive", key)) ?? "";
	const callback = (state: string, route = "momoan-sync-auth") => "obsidian://" + route + "?code=CODE&state=" + encodeURIComponent(state);
	return { connection, secrets, opened, request, sink, value, callback, config: () => config };
}

function expectPendingCleared(f: ReturnType<typeof fixture>): void {
	expect(f.value("pendingCodeVerifier")).toBe("");
	for (const key of ["pendingAuthState", "pendingFolderPickState", "pendingAuthExpiresAt", "pendingCodeVerifier"]) {
		expect(f.config()[key] ?? "").toBe("");
	}
}

describe("Momoan BYO Google OAuth and Picker contract", () => {
	it("generates S256 proof in SecretStorage and restores it for the code exchange", async () => {
		const f = fixture();
		await f.connection.startAuth();
		const url = new URL(f.opened[0]!);
		const verifier = f.value("pendingCodeVerifier");
		expect(verifier.length).toBeGreaterThanOrEqual(43);
		expect(url.searchParams.get("client_id")).toBe(CID);
		expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toBe(await computeS256Challenge(verifier));
		expect(f.config().pendingCodeVerifier).toBeUndefined();
		expect(JSON.stringify(f.config())).not.toContain(CS);
		await f.connection.completeAuth(f.callback(requireString(f.config().pendingAuthState)));
		const body = new URLSearchParams(requireString(f.request.mock.calls[0]![0].body));
		expect(body.get("code_verifier")).toBe(verifier);
		expect(body.get("client_secret")).toBe(CS);
		expect(f.value("refresh")).toBe(TOKEN.refresh_token);
		expectPendingCleared(f);
		expect(JSON.stringify(f.sink.mock.calls)).not.toContain(verifier);
		expect(JSON.stringify(f.config())).not.toContain(TOKEN.refresh_token);
	});

	it("rejects state mismatch without network I/O and discards pending proof", async () => {
		const f = fixture(); await f.connection.startAuth();
		await expect(f.connection.completeAuth(f.callback("evil"))).rejects.toThrow("State mismatch");
		expect(f.request).not.toHaveBeenCalled(); expectPendingCleared(f);
	});

	it("discards proof on expiration, cancellation, and browser-open failure", async () => {
		const expired = fixture(); await expired.connection.startAuth();
		expired.config().pendingAuthExpiresAt = Date.now() - 1;
		await expect(expired.connection.completeAuth(expired.callback(requireString(expired.config().pendingAuthState)))).rejects.toThrow("expired");
		expectPendingCleared(expired);
		const cancelled = fixture(); await cancelled.connection.startAuth(); await cancelled.connection.cancelPending();
		expectPendingCleared(cancelled);
		const closed = fixture(); await closed.connection.startAuth(); await closed.connection.dispose(); expectPendingCleared(closed);
		const failed = fixture(FOLDER, true); await expect(failed.connection.startAuth()).rejects.toThrow("Browser unavailable"); expectPendingCleared(failed);
	});

	it("cleans proof on exchange failure and rejects an access-token-only callback", async () => {
		const f = fixture(); await f.connection.startAuth();
		f.request.mockRejectedValueOnce(new Error("exchange failed"));
		await expect(f.connection.completeAuth(f.callback(requireString(f.config().pendingAuthState)))).rejects.toThrow();
		expectPendingCleared(f);
		await f.connection.startAuth();
		await expect(f.connection.completeAuth("obsidian://momoan-sync-auth?access_token=OLD&state=" + encodeURIComponent(requireString(f.config().pendingAuthState)))).rejects.toThrow("Authorization code is missing");
		expect(f.value("refresh")).toBe(""); expectPendingCleared(f);
	});

	it("starts the BYO top-level folder Picker with drive.file and S256", async () => {
		const f = fixture(); await f.connection.beginPick();
		const url = new URL(f.opened[0]!);
		expect(url.searchParams.get("trigger_onepick")).toBe("true");
		expect(url.searchParams.get("allow_folder_selection")).toBe("true");
		expect(url.searchParams.get("mimetypes")).toBe(FOLDER.mimeType);
		expect(url.searchParams.get("client_id")).toBe(CID);
		expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(f.config().pendingFolderPickState).toBe(f.config().pendingAuthState);
	});

	it("rejects mismatched Picker state before committing a remote root", async () => {
		const f = fixture(); await f.connection.beginPick();
		await expect(f.connection.completePick({ state: "evil", picked_file_ids: "folder-1" })).rejects.toThrow("State mismatch");
		expect(f.config().remoteVaultFolderId).toBeUndefined(); expect(f.request).not.toHaveBeenCalled(); expectPendingCleared(f);
	});

	it("requires exactly one non-empty folder ID", async () => {
		for (const picked_file_ids of ["", "folder-1,folder-2", "folder-1,", "folder/1"]) {
			const f = fixture(); await f.connection.beginPick();
			await expect(f.connection.completePick({ state: requireString(f.config().pendingFolderPickState), picked_file_ids })).rejects.toThrow("exactly one folder");
			expect(f.config().remoteVaultFolderId).toBeUndefined(); expect(f.request).not.toHaveBeenCalled(); expectPendingCleared(f);
		}
	});

	it("rejects unusable and mismatched folders through the existing inspection", async () => {
		for (const folder of [{ ...FOLDER, mimeType: "text/plain" }, { ...FOLDER, trashed: true }, { ...FOLDER, id: "other" }]) {
			const f = fixture(folder); await f.connection.beginPick();
			await expect(f.connection.completePick({ code: "CODE", state: requireString(f.config().pendingFolderPickState), picked_file_ids: "folder-1" })).rejects.toThrow("not usable");
			expect(f.config().remoteVaultFolderId).toBeUndefined(); expectPendingCleared(f);
		}
	});

	it("binds a verified folder through the folder callback and clears all correlation", async () => {
		const f = fixture(); await f.connection.beginPick();
		const target = await f.connection.completePick({ code: "CODE", state: requireString(f.config().pendingFolderPickState), picked_file_ids: "folder-1" });
		expect(target).toEqual({ id: "folder-1" }); expect(f.config().remoteVaultFolderId).toBe("folder-1");
		expect(f.config().remoteVaultFolderName).toBe("Vault"); expectPendingCleared(f);
	});

	it("binds after the auth callback without exchanging its code twice", async () => {
		const f = fixture(); await f.connection.beginPick(); const state = requireString(f.config().pendingFolderPickState);
		await f.connection.completeAuth(f.callback(state));
		await f.connection.completePick({ code: "CODE", state, picked_file_ids: "folder-1" });
		expect(f.request.mock.calls.filter(([request]) => request.url.includes("/token"))).toHaveLength(1);
		expectPendingCleared(f);
	});

	it("disconnect clears device credentials, client secret, temporary proof and binding", async () => {
		const f = fixture(); await f.connection.startAuth(); await f.connection.completeAuth(f.callback(requireString(f.config().pendingAuthState)));
		await f.connection.beginPick(); await f.connection.disconnect();
		for (const key of ["refresh", "access", "clientSecret", "pendingCodeVerifier"]) expect(f.value(key)).toBe("");
		expectPendingCleared(f); expect(f.config().remoteVaultFolderId).toBeUndefined();
	});

	it("a correlated denial cancels pending auth; another device owns no token", async () => {
		const f = fixture(); await f.connection.startAuth(); const state = requireString(f.config().pendingAuthState);
		const cancelAuth = vi.fn();
		handleOAuthProtocolCallback({ error: "access_denied", state }, state, { notify: vi.fn(), cancelAuth, completeConnect: vi.fn(), completeFolderPick: vi.fn() });
		expect(cancelAuth).toHaveBeenCalledOnce();
		const second = fixture(); expect(second.value("refresh")).toBe(""); expect(second.value("access")).toBe("");
	});
});
