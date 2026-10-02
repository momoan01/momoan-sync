import { describe, expect, it } from "vitest";
import { GoogleAuthDirect } from "../../src/backends/googledrive/auth";
import { GoogleDriveClient } from "../../src/backends/googledrive/client";
import { createPlatformTransport } from "../../src/fs/platform-http-transport";
import { FOLDER_MIME } from "../../src/backends/googledrive/types";
import { captureExternalNavigation } from "./chrome";
import { parseCallbackEnvelope, safeFailure, validateAuthorizationUrl, PickerE2EError } from "./oracle";
import { loadDotEnvE2e } from "../helpers/env";
import { preflight } from "./preflight";

describe("BYO Google top-level folder Picker (interactive T3)", () => {
	it("observes the Momoan callback external-protocol attempt and validates the selected live folder", async () => {
		try {
			process.stderr.write("[google-picker-e2e:preflight:started]\n");
			const runtime = await preflight();
			loadDotEnvE2e();
			const clientId = process.env.AIRSYNC_E2E_GOOGLE_CLIENT_ID;
			const clientSecret = process.env.AIRSYNC_E2E_GOOGLE_CLIENT_SECRET;
			if (!clientId || !clientSecret) throw new PickerE2EError("byo-credentials-missing", "preflight");
			const auth = new GoogleAuthDirect({ clientId, clientSecret, transport: createPlatformTransport() });
			const authorizationUrl = await auth.getFolderPickerAuthorizationUrl();
			const expectedState = auth.getAuthState();
			if (!expectedState) throw new PickerE2EError("state-missing", "google-authorization");
			validateAuthorizationUrl(authorizationUrl, expectedState, clientId);
			process.stderr.write("[google-picker-e2e:google-authorization:waiting-for-human]\n");
			const externalNavigation = await captureExternalNavigation(runtime, authorizationUrl);
			const envelope = parseCallbackEnvelope(externalNavigation.url, expectedState);
			try {
				await auth.handleAuthCallback({ code: envelope.code, state: envelope.state });
			} catch {
				throw new PickerE2EError("direct-token-exchange", "token-exchange");
			}
			process.stderr.write("[google-picker-e2e:drive-folder:validating]\n");
			let file;
			try {
				const client = new GoogleDriveClient(() => auth.getAccessToken(), createPlatformTransport());
				file = await client.getFile(envelope.pickedFileId);
			} catch {
				throw new PickerE2EError("drive-request", "drive-folder");
			}
			if (file.id !== envelope.pickedFileId || file.mimeType !== FOLDER_MIME) {
				throw new PickerE2EError("drive-folder-invalid", "drive-folder");
			}
			expect(auth.getAuthState()).toBeNull();
			expect(auth.getCodeVerifier()).toBeNull();
			process.stderr.write("[google-picker-e2e:drive-folder:success]\n");
		} catch (error) {
			throw new Error(safeFailure(error));
		}
	}, 610_000);
});
