import { describe, it, expect, vi } from "vitest";
import { spyRequestUrl, mockRes, testTransport } from "./test-helpers.test";

vi.mock("obsidian");

describe("GoogleAuthDirect.handleAuthCallback", () => {
	it("stores tokens when state matches", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "access-123", refresh_token: "refresh-456", expires_in: 3600, token_type: "Bearer" }));
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		auth.setAuthState("my-csrf");

		auth.setCodeVerifier("test-verifier");
		await auth.handleAuthCallback({
			code: "authorization-code",
			state: "my-csrf",
		});

		const tokens = auth.getTokenState();
		expect(tokens.accessToken).toBe("access-123");
		expect(tokens.refreshToken).toBe("refresh-456");
		expect(tokens.accessTokenExpiry).toBeGreaterThan(Date.now());
		mockRequestUrl.mockRestore();
	});

	it("throws when authState is null", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });

		await expect(
			auth.handleAuthCallback({
				access_token: "token",
				expires_in: "3600",
				state: "some-state",
			})
		).rejects.toThrow("OAuth state is missing");
	});

	it("throws when state does not match", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		auth.setAuthState("correct-state");

		await expect(
			auth.handleAuthCallback({
				access_token: "token",
				expires_in: "3600",
				state: "wrong-state",
			})
		).rejects.toThrow("State mismatch");
	});

	it("throws when state parameter is omitted", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		auth.setAuthState("expected-state");

		await expect(
			auth.handleAuthCallback({
				access_token: "token",
				expires_in: "3600",
			})
		).rejects.toThrow("State mismatch");
	});

	it("clears authState after successful callback", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "token", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" }));
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		auth.setAuthState("csrf");

		auth.setCodeVerifier("test-verifier");
		await auth.handleAuthCallback({
			code: "authorization-code",
			state: "csrf",
		});

		expect(auth.getAuthState()).toBeNull();
		mockRequestUrl.mockRestore();
	});
});

describe("GoogleAuthDirect.getAuthorizationUrl", () => {
	it("returns a Google OAuth URL with state and PKCE", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });

		const url = await auth.getAuthorizationUrl();

		expect(url).toContain("accounts.google.com");
		expect(url).toContain("state=");
		expect(url).toContain("code_challenge_method=S256");
		expect(auth.getAuthState()).not.toBeNull();
	});

	it("produces a URL-safe (base64url) state that survives redirect hops", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		await auth.getAuthorizationUrl();

		const state = auth.getAuthState();
		expect(state).not.toBeNull();
		// base64url contains none of the chars a form-decoder would mangle.
		expect(state!).not.toMatch(/[+/=]/);
		// Still decodes to the expected payload (normalize back to standard base64).
		const b64 = state!.replace(/-/g, "+").replace(/_/g, "/");
		const decoded = JSON.parse(
			atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)),
		) as { nonce: string; app?: unknown };
		expect(decoded).not.toHaveProperty("app");
		expect(typeof decoded.nonce).toBe("string");
	});

	it("builds the top-level Google Picker OAuth flow for folder selection", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });

		const url = new URL(await auth.getFolderPickerAuthorizationUrl());

		expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("trigger_onepick")).toBe("true");
		expect(url.searchParams.get("allow_folder_selection")).toBe("true");
		expect(url.searchParams.get("mimetypes")).toBe("application/vnd.google-apps.folder");
		expect(url.searchParams.get("state")).toBe(auth.getAuthState());
	});
});

describe("GoogleAuthDirect.getAccessToken concurrency", () => {
	it("deduplicates concurrent refresh calls", async () => {
		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			async () => {
				callCount++;
				await new Promise((r) => setTimeout(r, 50));
				return mockRes({
					access_token: "new-access-token",
					expires_in: 3600,
					token_type: "Bearer",
				});
			}
		);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		auth.setTokens("refresh-token", "", 0);

		const [t1, t2, t3] = await Promise.all([
			auth.getAccessToken(),
			auth.getAccessToken(),
			auth.getAccessToken(),
		]);

		expect(callCount).toBe(1);
		expect(t1).toBe("new-access-token");
		expect(t2).toBe("new-access-token");
		expect(t3).toBe("new-access-token");

		mockRequestUrl.mockRestore();
	});

	it("short-circuits after refresh failure with status 400", async () => {
		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			() => {
				callCount++;
				const err = new Error("Request failed, status 400");
				(err as Error & { status: number }).status = 400;
				throw err;
			}
		);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		auth.setTokens("refresh-token", "", 0);

		await expect(auth.getAccessToken()).rejects.toThrow("status 400");
		expect(callCount).toBe(1);

		await expect(auth.getAccessToken()).rejects.toThrow(
			"Authentication expired"
		);
		expect(callCount).toBe(1);

		mockRequestUrl.mockRestore();
	});

	it("retries refresh after cooldown period elapses", async () => {
		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			async () => {
				callCount++;
				if (callCount === 1) {
					const err = new Error("Request failed, status 400");
					(err as Error & { status: number }).status = 400;
					throw err;
				}
				return await Promise.resolve(mockRes({
					access_token: "recovered",
					expires_in: 3600,
					token_type: "Bearer",
				}));
			}
		);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		auth.setTokens("refresh-token", "", 0);

		const now = Date.now();
		const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

		await expect(auth.getAccessToken()).rejects.toThrow("status 400");
		expect(callCount).toBe(1);

		// Within cooldown: short-circuits
		dateNowSpy.mockReturnValue(now + 30_000);
		await expect(auth.getAccessToken()).rejects.toThrow("Authentication expired");
		expect(callCount).toBe(1);

		// After cooldown: retries and succeeds
		dateNowSpy.mockReturnValue(now + 60_001);
		const token = await auth.getAccessToken();
		expect(token).toBe("recovered");
		expect(callCount).toBe(2);

		dateNowSpy.mockRestore();
		mockRequestUrl.mockRestore();
	});

	it("resets authFailed when setTokens is called", async () => {
		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			async () => {
				callCount++;
				if (callCount === 1) {
					const err = new Error("Request failed, status 400");
					(err as Error & { status: number }).status = 400;
					throw err;
				}
				return await Promise.resolve(mockRes({
					access_token: "recovered",
					expires_in: 3600,
					token_type: "Bearer",
				}));
			}
		);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		auth.setTokens("refresh-token", "", 0);

		await expect(auth.getAccessToken()).rejects.toThrow("status 400");

		auth.setTokens("new-refresh-token", "", 0);
		const token = await auth.getAccessToken();
		expect(token).toBe("recovered");
		expect(callCount).toBe(2);

		mockRequestUrl.mockRestore();
	});
});

describe("GoogleAuthDirect.revokeToken", () => {
	it("calls Google revoke endpoint", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(mockRes({}));

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		auth.setTokens("my-refresh-token", "", 0);

		await auth.revokeToken();

		const callArg = mockRequestUrl.mock.calls[0]?.[0] as { url: string; method: string };
		expect(callArg.url).toContain("oauth2.googleapis.com/revoke");
		expect(callArg.method).toBe("POST");
		expect(callArg.url).toContain("my-refresh-token");

		mockRequestUrl.mockRestore();
	});

	it("does not throw when revoke fails", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockRejectedValue(
			new Error("Network error")
		);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });
		auth.setTokens("token", "", 0);

		await expect(auth.revokeToken()).resolves.toBeUndefined();

		mockRequestUrl.mockRestore();
	});

	it("skips revoke when no token is set", async () => {
		const mockRequestUrl = await spyRequestUrl();

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "byo-client", clientSecret: "byo-secret" });

		await auth.revokeToken();
		expect(mockRequestUrl).not.toHaveBeenCalled();

		mockRequestUrl.mockRestore();
	});
});

describe("GoogleAuthDirect.getAuthorizationUrl", () => {
	it("uses custom client_id and includes PKCE S256 challenge", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "custom-client-id", clientSecret: "custom-secret" });

		const url = await auth.getAuthorizationUrl();

		expect(url).toContain("accounts.google.com");
		expect(url).toContain("client_id=custom-client-id");
		expect(url).toContain("code_challenge=");
		expect(url).toContain("code_challenge_method=S256");
		expect(auth.getCodeVerifier()).not.toBeNull();

		const state = auth.getAuthState();
		expect(state).not.toBeNull();
		// State is base64url (URL-safe); normalize back to standard base64 to decode.
		expect(state!).not.toMatch(/[+/=]/);
		const b64 = state!.replace(/-/g, "+").replace(/_/g, "/");
		const decoded = JSON.parse(
			atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)),
		) as { custom: boolean };
		expect(decoded.custom).toBe(true);
	});
});

describe("GoogleAuthDirect.getAuthorizationUrl with includeGrantedScopes", () => {
	it("includes include_granted_scopes when enabled", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "cid", clientSecret: "csecret", includeGrantedScopes: true });

		const url = await auth.getAuthorizationUrl();

		expect(url).toContain("include_granted_scopes=true");
	});

	it("omits include_granted_scopes when disabled", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "cid", clientSecret: "csecret", includeGrantedScopes: false });

		const url = await auth.getAuthorizationUrl();

		expect(url).not.toContain("include_granted_scopes");
	});

	it("omits include_granted_scopes by default", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "cid", clientSecret: "csecret" });

		const url = await auth.getAuthorizationUrl();

		expect(url).not.toContain("include_granted_scopes");
	});
});

describe("GoogleAuthDirect.handleAuthCallback", () => {
	it("exchanges code for tokens with PKCE code_verifier", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(
			mockRes({
				access_token: "direct-access",
				refresh_token: "direct-refresh",
				expires_in: 3600,
				token_type: "Bearer",
			})
		);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "my-client-id", clientSecret: "my-secret" });
		auth.setAuthState("csrf-state");
		auth.setCodeVerifier("test-verifier-string");

		await auth.handleAuthCallback({
			code: "auth-code-123",
			state: "csrf-state",
		});

		const tokens = auth.getTokenState();
		expect(tokens.accessToken).toBe("direct-access");
		expect(tokens.refreshToken).toBe("direct-refresh");

		const callArg = mockRequestUrl.mock.calls[0]?.[0] as { url: string; method: string };
		expect(callArg.url).toContain("oauth2.googleapis.com/token");
		expect(callArg.method).toBe("POST");
		// Verify body contains client credentials and PKCE verifier
		const callBody = mockRequestUrl.mock.calls[0]?.[0];
		const body = typeof callBody === "object" && callBody !== null && "body" in callBody
			? (callBody as { body: string }).body : "";
		expect(body).toContain("client_id=my-client-id");
		expect(body).toContain("client_secret=my-secret");
		expect(body).toContain("code=auth-code-123");
		expect(body).toContain("grant_type=authorization_code");
		expect(body).toContain("code_verifier=test-verifier-string");

		mockRequestUrl.mockRestore();
	});

	it("throws when code is missing", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "id", clientSecret: "secret" });
		auth.setAuthState("state");
		auth.setCodeVerifier("verifier");

		await expect(
			auth.handleAuthCallback({ state: "state" })
		).rejects.toThrow("Authorization code is missing");
	});

	it("throws when code verifier is missing", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "id", clientSecret: "secret" });
		auth.setAuthState("state");

		await expect(
			auth.handleAuthCallback({ code: "code", state: "state" })
		).rejects.toThrow("PKCE code verifier is missing");
	});

	it("does not expose provider response bodies that may contain credentials", async () => {
		const err = new Error("Request failed, status 400");
		Object.assign(err, {
			status: 400,
			// `error_uri` stands in for the fields a picked `error: error_description`
			// pair used to drop: the body must reach the message intact.
			json: {
				error: "redirect_uri_mismatch",
				error_description: "Bad Request",
				error_uri: "https://developers.google.com/identity/protocols/oauth2",
			},
		});
		const mockRequestUrl = (await spyRequestUrl()).mockRejectedValue(err);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "id", clientSecret: "secret" });
		auth.setAuthState("state");
		auth.setCodeVerifier("verifier");

		const thrown = auth.handleAuthCallback({ code: "code", state: "state" });
		await expect(thrown).rejects.toThrow("Token exchange failed");
		await expect(thrown).rejects.not.toThrow("redirect_uri_mismatch");
		await expect(thrown).rejects.not.toThrow("Bad Request");
		await expect(thrown).rejects.not.toThrow("developers.google.com");

		mockRequestUrl.mockRestore();
	});

	it("uses a safe exchange failure without forwarding transport details", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockRejectedValue(
			new Error("Network error")
		);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "id", clientSecret: "secret" });
		auth.setAuthState("state");
		auth.setCodeVerifier("verifier");

		await expect(
			auth.handleAuthCallback({ code: "code", state: "state" })
		).rejects.toThrow("Token exchange failed. Please reconnect.");

		mockRequestUrl.mockRestore();
	});
});

describe("GoogleAuthDirect._refreshToken", () => {
	it("refreshes directly against Google token endpoint", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(
			mockRes({
				access_token: "refreshed-access",
				expires_in: 3600,
				token_type: "Bearer",
			})
		);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect({ transport: testTransport(), clientId: "my-client", clientSecret: "my-secret" });
		auth.setTokens("my-refresh", "", 0);

		const token = await auth.getAccessToken();
		expect(token).toBe("refreshed-access");

		const callBody = mockRequestUrl.mock.calls[0]?.[0];
		const body = typeof callBody === "object" && callBody !== null && "body" in callBody
			? (callBody as { body: string }).body : "";
		expect(body).toContain("grant_type=refresh_token");
		expect(body).toContain("client_id=my-client");
		expect(body).toContain("client_secret=my-secret");
		expect(body).toContain("refresh_token=my-refresh");

		mockRequestUrl.mockRestore();
	});
});


