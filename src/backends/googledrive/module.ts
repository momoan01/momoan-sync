import type {
	BackendAuth,
	BackendBinding,
	BackendModule,
	BackendRuntimeContext,
	BackendSettingsDefinition,
	BindingResult,
	JsonObject,
	JsonPatch,
	RemoteBackendAdapter,
} from "../../backend-api";
import { BACKEND_MODULE_API_VERSION } from "../../backend-api";
import { GoogleAuthDirect } from "./auth";
import { GoogleDriveClient } from "./client";
import { GoogleDriveAdapter } from "./adapter";
import { withAdapterState } from "../shared/adapter-state";
import { createContextTransport } from "../../backend-api/http-transport";
import { asString, resolveFolderTarget } from "../shared/module-utils";
import { parseAuthCallbackParams } from "./auth-callback";
import { resolveGoogleDriveRemoteVault } from "./remote-vault";
import { resolveFolderPath } from "./folder-path";
import { inspectGoogleDriveFolder, describeFetchedGoogleDriveFolderProblem } from "./folder-usability";

const SETTINGS: BackendSettingsDefinition = {
	fields: [
		{ key: "clientId", label: "Client ID", type: "text" },
		{ key: "redirectUri", label: "Redirect URI", type: "text",
			description: "Use the redirect URI registered for your own Google OAuth app." },
	],
};

async function buildAuth(context: BackendRuntimeContext, config: Readonly<JsonObject>): Promise<GoogleAuthDirect> {
	return new GoogleAuthDirect({
		clientId: asString(config.clientId),
		clientSecret: (await context.secrets.get("clientSecret")) ?? "",
		transport: createContextTransport(context.http),
		redirectUri: asString(config.redirectUri),
		logger: context.logger,
	});
}

const PENDING_KEYS = ["pendingAuthState", "pendingFolderPickState", "pendingCodeVerifier", "pendingAuthExpiresAt"];
const AUTH_LIFETIME_MS = 10 * 60 * 1000;

function assertPendingFresh(config: Readonly<JsonObject>): void {
	if (typeof config.pendingAuthExpiresAt !== "number" || Date.now() >= config.pendingAuthExpiresAt) {
		throw new Error("Authorization expired. Please restart the connection flow.");
	}
}

async function beginAuthorization(context: BackendRuntimeContext, config: Readonly<JsonObject>, folderPick: boolean): Promise<JsonPatch> {
	if (!asString(config.clientId) || !(await context.secrets.get("clientSecret"))) {
		throw new Error("Client ID and client secret are required.");
	}
	const google = await buildAuth(context, config);
	const url = folderPick ? await google.getFolderPickerAuthorizationUrl() : await google.getAuthorizationUrl();
	const verifier = google.getCodeVerifier();
	if (!verifier) throw new Error("PKCE code verifier is missing.");
	await context.secrets.set("pendingCodeVerifier", verifier);
	try {
		await context.auth.openExternal(url);
	} catch (error) {
		await context.secrets.delete("pendingCodeVerifier");
		throw error;
	}
	const state = google.getAuthState() ?? "";
	return {
		set: { pendingAuthState: state, pendingFolderPickState: folderPick ? state : "", pendingAuthExpiresAt: Date.now() + AUTH_LIFETIME_MS },
		unset: ["pendingCodeVerifier"],
	};
}

const auth: BackendAuth = {
	credentialKeys: ["refresh", "access"],
	start: (context, config) => beginAuthorization(context, config, false),
	cancelPending: async (context) => {
		await context.secrets.delete("pendingCodeVerifier");
		return { unset: PENDING_KEYS };
	},
	complete: async (context, input, config) => {
		assertPendingFresh(config);
		const google = await buildAuth(context, config);
		if (!google.getAuthState() && asString(config.pendingAuthState)) {
			google.setAuthState(asString(config.pendingAuthState));
		}
		const verifier = await context.secrets.get("pendingCodeVerifier");
		if (verifier) google.setCodeVerifier(verifier);
		try {
			await google.handleAuthCallback(parseAuthCallbackParams(input));
		} finally {
			await context.secrets.delete("pendingCodeVerifier");
		}
		const tokens = google.getTokenState();
		if (!tokens.refreshToken) {
			throw new Error("The provider did not return a refresh token. Reconnect and consent again.");
		}
		await context.secrets.set("refresh", tokens.refreshToken);
		await context.secrets.set("access", tokens.accessToken);
		return { set: { accessTokenExpiry: tokens.accessTokenExpiry, pendingAuthState: "" }, unset: config.pendingFolderPickState ? ["pendingCodeVerifier"] : ["pendingCodeVerifier", "pendingAuthExpiresAt"] };
	},
	revoke: async (context, config) => {
		try {
			const refresh = await context.secrets.get("refresh");
			if (refresh) {
				const google = await buildAuth(context, config);
				google.setTokens(refresh, (await context.secrets.get("access")) ?? "", 0);
				await google.revokeToken();
			}
		} finally {
			await context.secrets.delete("clientSecret");
			await context.secrets.delete("pendingCodeVerifier");
		}

	},
};

async function buildClient(
	context: BackendRuntimeContext,
	config: Readonly<JsonObject>,
): Promise<GoogleDriveClient> {
	const google = await buildAuth(context, config);
	const expiry = typeof config.accessTokenExpiry === "number" ? config.accessTokenExpiry : 0;
	google.setRefreshTokenRotatedHook((rotated) => context.secrets.set("refresh", rotated));
	google.setTokens(
		(await context.secrets.get("refresh")) ?? "",
		(await context.secrets.get("access")) ?? "",
		expiry,
	);
	return new GoogleDriveClient((force) => google.getAccessToken(force), createContextTransport(context.http), context.logger);
}

async function buildClientState(
	context: BackendRuntimeContext,
	config: Readonly<JsonObject>,
): Promise<{ client: GoogleDriveClient; readExpiry: () => number }> {
	const google = await buildAuth(context, config);
	const expiry = typeof config.accessTokenExpiry === "number" ? config.accessTokenExpiry : 0;
	google.setRefreshTokenRotatedHook((rotated) => context.secrets.set("refresh", rotated));
	google.setTokens(
		(await context.secrets.get("refresh")) ?? "",
		(await context.secrets.get("access")) ?? "",
		expiry,
	);
	return {
		client: new GoogleDriveClient((force) => google.getAccessToken(force), createContextTransport(context.http), context.logger),
		readExpiry: () => google.getTokenState().accessTokenExpiry,
	};
}

const binding: BackendBinding = {
	resolveDefault: async (context, config, vaultName): Promise<BindingResult> => {
		const client = await buildClient(context, config);
		const cached = asString(config.remoteVaultFolderId) || undefined;
		const resolution = await resolveGoogleDriveRemoteVault(client, vaultName, cached);
		const id = asString(resolution.backendUpdates.remoteVaultFolderId);
		return { patch: { set: { remoteVaultFolderId: id } }, target: { id } };
	},
	beginPick: (context, config) => beginAuthorization(context, config, true),
	completePick: async (context, params, config): Promise<BindingResult> => {
		assertPendingFresh(config);
		const expected = asString(config.pendingFolderPickState);
		if (!expected || params.state !== expected) throw new Error("State mismatch - possible CSRF attack");
		const picked = (params.picked_file_ids ?? "").split(",").map((value) => value.trim());
		if (picked.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(picked[0] ?? "")) throw new Error("Please select exactly one folder.");
		const id = picked[0]!;
		if (config.pendingAuthState && !params.code) throw new Error("Authorization code is missing from folder callback");
		// The folder protocol may carry the code itself; the auth protocol has already exchanged it.
		const authPatch = params.code && config.pendingAuthState
			? await auth.complete(context, "obsidian://momoan-sync-folder?" + new URLSearchParams(params).toString(), config)
			: {};
		const current = { ...config, ...authPatch.set };
		const client = await buildClient(context, current);
		const inspection = await inspectGoogleDriveFolder(client, id);
		if (!inspection.usable || inspection.file.id !== id) throw new Error("That folder is not usable. Re-pick it in the Google Picker.");
		return {
			patch: { set: { ...authPatch.set, remoteVaultFolderId: id, remoteVaultFolderName: inspection.file.name }, unset: PENDING_KEYS },
			target: { id },
		};
	},
	getDisplayPath: async (context, config, target) => {
		const client = await buildClient(context, config);
		const resolved = await resolveFolderPath(client, target.id);
		if (!resolved) return null;
		return resolved.problem
			? {
					id: target.id,
					displayPath: resolved.path,
					warning: describeFetchedGoogleDriveFolderProblem(resolved.problem),
				}
			: { id: target.id, displayPath: resolved.path };
	},
};

/** The canonical Google Drive backend module. */
export const googleDriveModule: BackendModule = {
	id: "googledrive",
	displayName: "Google Drive",
	version: "1.0.0",
	apiVersion: BACKEND_MODULE_API_VERSION,
	auth,
	settings: SETTINGS,
	binding,
	getTarget: resolveFolderTarget,
	disconnectConfig: (config) => {
		const bag: JsonObject = {};
		for (const key of ["clientId", "redirectUri"]) {
			const value = config[key];
			if (typeof value === "string") bag[key] = value;
		}
		return bag;
	},
	createAdapter: async (context, config, target): Promise<RemoteBackendAdapter> => {
		const { client, readExpiry } = await buildClientState(context, config);
		return withAdapterState(new GoogleDriveAdapter(client, target.id), () => ({
			accessTokenExpiry: readExpiry(),
		}));
	},
};
