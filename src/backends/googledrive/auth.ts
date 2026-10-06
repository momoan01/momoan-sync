import type { BackendLogger } from "../../backend-api";
import type { HttpTransport } from "../../backend-api/http-transport";
import { assertTokenResponse } from "./types";
import {
	BaseOAuthTokenManager,
	buildOAuthState,
	computeS256Challenge,
	generateRandomString,
} from "../../backend-api/oauth-pkce";
import { DEFAULT_CUSTOM_REDIRECT_URI } from "../shared/auth-config";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/drive";
export const DEFAULT_CUSTOM_SCOPE = SCOPES;

/** Google BYO OAuth contract. */
export interface IGoogleAuth {
	setTokens(refreshToken: string, accessToken: string, expiry: number): void;
	/**
	 * Register a hook fired when a refresh rotates the refresh token to a new
	 * value. Lets a detached (throwaway) auth persist a rotated token that would
	 * otherwise be discarded with the instance — leaving the shared/stored token
	 * stale and failing the next real refresh.
	 */
	setRefreshTokenRotatedHook(cb: (refreshToken: string) => void | Promise<void>): void;
	readonly isAuthenticated: boolean;
	getAuthorizationUrl(): Promise<string>;
	getAuthState(): string | null;
	setAuthState(authState: string): void;
	getCodeVerifier(): string | null;
	setCodeVerifier(verifier: string): void;
	handleAuthCallback(params: Record<string, string | undefined>): Promise<void>;
	getAccessToken(forceRefresh?: boolean): Promise<string>;
	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number };
	revokeToken(): Promise<void>;
}

/**
 * Base class for Google OAuth implementations. Inherits the OAuth token
 * lifecycle (skew/cooldown/dedup/rotation) from {@link BaseOAuthTokenManager}
 * and adds Google's CSRF state, PKCE verifier, and token revocation. Subclasses
 * provide the auth URL, callback handling, and refresh strategy.
 */
abstract class GoogleAuthBase extends BaseOAuthTokenManager implements IGoogleAuth {
	protected readonly transport: HttpTransport;
	private authState: string | null = null;
	private codeVerifier: string | null = null;

	constructor(transport: HttpTransport) {
		super();
		this.transport = transport;
	}

	protected notAuthenticatedMessage(): string {
		return "Not authenticated. Please connect to Google Drive first.";
	}

	abstract getAuthorizationUrl(): Promise<string>;

	getAuthState(): string | null {
		return this.authState;
	}

	setAuthState(authState: string): void {
		this.authState = authState;
	}

	getCodeVerifier(): string | null {
		return this.codeVerifier;
	}

	setCodeVerifier(verifier: string): void {
		this.codeVerifier = verifier;
	}

	protected clearCodeVerifier(): void {
		this.codeVerifier = null;
	}

	abstract handleAuthCallback(params: Record<string, string | undefined>): Promise<void>;

	async revokeToken(): Promise<void> {
		const token = this.refreshToken || this.accessToken;
		if (!token) return;

		try {
			await this.transport.request({
				url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
			});
		} catch {
			this.logger?.warn("Failed to revoke Google token (non-fatal)");
		}
	}

	/** Verify CSRF state and clear it. Returns the validated state. */
	protected verifyAndClearState(state: string | undefined): void {
		if (!this.authState) {
			throw new Error("OAuth state is missing. Please restart the authorization flow.");
		}
		if (!state || state !== this.authState) {
			throw new Error("State mismatch - possible CSRF attack");
		}
	}

	protected clearAuthState(): void {
		this.authState = null;
	}

	/** Generate (and store as the pending CSRF state) a base64url OAuth state value. */
	protected generateState(extra: Record<string, unknown> = {}): string {
		this.authState = buildOAuthState(extra);
		return this.authState;
	}
}

/** Direct BYO OAuth. The static HTTPS callback relays codes, never tokens. */
export interface GoogleAuthDirectOptions {
	clientId: string;
	clientSecret: string;
	transport: HttpTransport;
	logger?: BackendLogger;
	scope?: string;
	redirectUri?: string;
	includeGrantedScopes?: boolean;
}

export class GoogleAuthDirect extends GoogleAuthBase {
	private clientId: string;
	private clientSecret: string;
	private scope: string;
	private redirectUri: string;
	private includeGrantedScopes: boolean;

	constructor(options: GoogleAuthDirectOptions) {
		super(options.transport);
		this.clientId = options.clientId;
		this.clientSecret = options.clientSecret;
		this.scope = options.scope || SCOPES;
		this.redirectUri = options.redirectUri?.trim() || DEFAULT_CUSTOM_REDIRECT_URI;
		this.includeGrantedScopes = options.includeGrantedScopes ?? false;
		this.logger = options.logger;
	}

	getAuthorizationUrl(): Promise<string> {
		return this.buildAuthorizationUrl(false);
	}

	/** Google owns the top-level Picker and returns a code and selected folder. */
	getFolderPickerAuthorizationUrl(): Promise<string> {
		return this.buildAuthorizationUrl(true);
	}

	private async buildAuthorizationUrl(folderPick: boolean): Promise<string> {
		const state = this.generateState(folderPick ? { custom: true, folderPick: true } : { custom: true });
		const codeVerifier = generateRandomString(64);
		this.setCodeVerifier(codeVerifier);
		const codeChallenge = await computeS256Challenge(codeVerifier);

		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: this.redirectUri,
			response_type: "code",
			scope: this.scope,
			access_type: "offline",
			prompt: "consent",
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		if (folderPick) {
			params.set("trigger_onepick", "true");
			params.set("allow_folder_selection", "true");
			params.set("mimetypes", "application/vnd.google-apps.folder");
		}
		if (this.includeGrantedScopes) {
			params.set("include_granted_scopes", "true");
		}
		return `${GOOGLE_AUTH_URL}?${params.toString()}`;
	}

	/**
	 * Exchange the authorization code for tokens directly with Google.
	 * The auth server passes back code + state without exchanging them.
	 * Sends code_verifier for PKCE verification.
	 */
	async handleAuthCallback(params: Record<string, string | undefined>): Promise<void> {
		try {
			this.verifyAndClearState(params.state);
			if (!params.code) throw new Error("Authorization code is missing from auth callback");
			const codeVerifier = this.getCodeVerifier();
			if (!codeVerifier) throw new Error("PKCE code verifier is missing. Please restart the authorization flow.");
			const response = await this.transport.request({
				url: GOOGLE_TOKEN_URL,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					code: params.code,
					client_id: this.clientId,
					client_secret: this.clientSecret,
					redirect_uri: this.redirectUri,
					grant_type: "authorization_code",
					code_verifier: codeVerifier,
				}).toString(),
			}).catch(() => { throw new Error("Token exchange failed. Please reconnect."); });
			const token: unknown = response.json;
			assertTokenResponse(token);
			await this.storeTokenResponse(token);
		} finally {
			this.clearAuthState();
			this.clearCodeVerifier();
		}
	}

	protected async performRefresh(): Promise<string> {
		this.logger?.info("Refreshing access token (direct)");
		try {
			const response = await this.transport.request({
				url: GOOGLE_TOKEN_URL,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					refresh_token: this.refreshToken,
					grant_type: "refresh_token",
				}).toString(),
			});

			const token: unknown = response.json;
			assertTokenResponse(token);
			await this.storeTokenResponse(token);
			return this.accessToken;
		} catch (err) {
			this.handleRefreshError(err);
		}
	}
}
