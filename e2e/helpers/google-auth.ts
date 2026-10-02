import type { IGoogleAuth } from "../../src/backends/googledrive/auth";
import { GoogleAuthDirect } from "../../src/backends/googledrive/auth";
import { createPlatformTransport } from "../../src/fs/platform-http-transport";
import type { BackendCreds } from "./env";
import { loadDotEnvE2e, readCreds } from "./env";

export const GOOGLE_E2E_REFRESH_TOKEN_ENV = "AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN";

/** Read the shared Google refresh token produced by the existing e2e bootstrap. */
export function readGoogleE2ECreds(): BackendCreds | null {
	return readCreds(GOOGLE_E2E_REFRESH_TOKEN_ENV);
}

/** Refresh only with the BYO OAuth client that issued the token. */
export function createGoogleE2EAuth(refreshToken: string): IGoogleAuth {
	loadDotEnvE2e();
	const clientId = process.env.AIRSYNC_E2E_GOOGLE_CLIENT_ID;
	const clientSecret = process.env.AIRSYNC_E2E_GOOGLE_CLIENT_SECRET;
	if (!clientId || !clientSecret) throw new Error("Google E2E requires BYO client credentials.");
	const auth = new GoogleAuthDirect({ clientId, clientSecret, transport: createPlatformTransport() });
	auth.setTokens(refreshToken, "", 0);
	return auth;
}
