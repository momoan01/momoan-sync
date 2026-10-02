import { FOLDER_MIME } from "../../src/backends/googledrive/types";

export const PRODUCTION_CALLBACK_URI = "https://momoan01.github.io/momoan-sync/oauth-callback/";
export const OBSIDIAN_CALLBACK_ORIGIN = "obsidian://momoan-sync-auth";

export type PickerStage =
	| "preflight"
	| "browser-launch"
	| "google-authorization"
	| "https-callback"
	| "token-exchange"
	| "external-navigation"
	| "callback-envelope"
	| "drive-folder"
	| "cleanup";

export class PickerE2EError extends Error {
	constructor(
		readonly errorClass: string,
		readonly stage: PickerStage,
	) {
		super(`[google-picker-e2e:${stage}:${errorClass}]`);
		this.name = "PickerE2EError";
	}
}

export interface NavigationEvidence {
	sequence: number;
	targetId: string;
	sessionId: string;
	frameId: string;
	loaderId?: string;
	url: string;
	source: "Page.frameRequestedNavigation" | "Network.requestWillBeSent";
}

export interface PickerCallbackEnvelope {
	code: string;
	pickedFileId: string;
	state: string;
}

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateAuthorizationUrl(rawUrl: string, expectedState: string, expectedClientId: string): void {
	const url = new URL(rawUrl);
	const params = url.searchParams;
	if (
		url.origin !== "https://accounts.google.com" ||
		url.pathname !== "/o/oauth2/v2/auth" ||
		params.get("trigger_onepick") !== "true" ||
		params.get("allow_folder_selection") !== "true" ||
		params.get("mimetypes") !== FOLDER_MIME ||
		params.get("scope") !== "https://www.googleapis.com/auth/drive.file" ||
		params.get("prompt") !== "consent" ||
		params.get("state") !== expectedState ||
		params.get("client_id") !== expectedClientId ||
		params.get("redirect_uri") !== PRODUCTION_CALLBACK_URI ||
		params.get("response_type") !== "code" ||
		params.get("code_challenge_method") !== "S256" ||
		!(/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? ""))
	) {
		throw new PickerE2EError("authorization-contract", "google-authorization");
	}
}

export function selectOrderedExternalNavigation(events: readonly NavigationEvidence[]): NavigationEvidence {
	const callbacks = events.filter((event) => {
		try {
			const url = new URL(event.url);
			return url.origin + url.pathname === PRODUCTION_CALLBACK_URI;
		} catch {
			return false;
		}
	});
	for (const callback of callbacks) {
		const external = events.find((event) =>
			event.sequence > callback.sequence &&
			event.targetId === callback.targetId &&
			event.sessionId === callback.sessionId &&
			event.frameId === callback.frameId &&
			(!callback.loaderId || !event.loaderId || event.loaderId === callback.loaderId) &&
			event.url.startsWith(`${OBSIDIAN_CALLBACK_ORIGIN}?`),
		);
		if (external) return external;
	}
	throw new PickerE2EError("ordered-external-navigation-missing", "external-navigation");
}

export function parseCallbackEnvelope(attemptedUrl: string, expectedState: string): PickerCallbackEnvelope {
	let url: URL;
	try {
		url = new URL(attemptedUrl);
	} catch {
		throw new PickerE2EError("callback-url-invalid", "callback-envelope");
	}
	if (url.protocol !== "obsidian:" || url.hostname !== "momoan-sync-auth" || url.pathname !== "") {
		throw new PickerE2EError("callback-route-invalid", "callback-envelope");
	}
	const ids = url.searchParams.getAll("picked_file_ids");
	const state = url.searchParams.get("state");
	const codes = url.searchParams.getAll("code");
	const code = codes[0];
	if (state !== expectedState) throw new PickerE2EError("callback-state-invalid", "callback-envelope");
	if (ids.length !== 1 || !FILE_ID_PATTERN.test(ids[0] ?? "")) {
		throw new PickerE2EError("callback-folder-id-invalid", "callback-envelope");
	}
	if (codes.length !== 1 || !code) throw new PickerE2EError("callback-code-invalid", "callback-envelope");
	if (url.searchParams.getAll("state").length !== 1 || url.searchParams.has("error")) {
		throw new PickerE2EError("callback-error", "callback-envelope");
	}
	return { code, pickedFileId: ids[0]!, state };
}

export function safeFailure(error: unknown): string {
	if (error instanceof PickerE2EError) return error.message;
	return "[google-picker-e2e:internal:unexpected]";
}

export function assertNoSecrets(output: string, secrets: readonly string[]): void {
	for (const secret of secrets) {
		const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
		if (forms.some((form) => form.length > 0 && output.includes(form))) {
			throw new PickerE2EError("secret-disclosure", "cleanup");
		}
	}
}
