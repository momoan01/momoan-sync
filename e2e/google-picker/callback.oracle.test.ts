import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_REDIRECT_URI, PLUGIN_REDIRECT_URI } from "../../src/backends/shared/auth-config";

const html = readFileSync("site/oauth-callback/index.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("Callback script is missing");

function relay(query: string) {
	const link = { href: "" };
	const replace = vi.fn();
	const replaceState = vi.fn();
	runInNewContext(script!, {
		URLSearchParams,
		window: { location: { search: query, pathname: "/momoan-sync/oauth-callback/", replace }, history: { replaceState } },
		document: { getElementById: (id: string) => { expect(id).toBe("open-obsidian"); return link; } },
	});
	return { link, replace, replaceState };
}

describe("Momoan static HTTPS OAuth callback", () => {
	it("relays only the allowlist with exact decoded values and Momoan protocol", () => {
		const values = { code: "code+/=&?#%", state: "state+/=&", picked_file_ids: "folder-1", scope: "scope with spaces", error: "access_denied" };
		const query = new URLSearchParams({ ...values, access_token: "must-drop", redirect_uri: "https://evil.test", unknown: "drop" });
		const result = relay("?" + query.toString());
		const url = new URL(result.link.href);
		expect(url.protocol + "//" + url.hostname).toBe(PLUGIN_REDIRECT_URI);
		expect(Object.fromEntries(url.searchParams)).toEqual(values);
		expect(result.replace).toHaveBeenCalledWith(result.link.href);
		expect(result.replaceState).toHaveBeenCalledWith(null, "", "/momoan-sync/oauth-callback/");
	});

	it("preserves duplicate allowlisted values for plugin validation and discards fragments", () => {
		const { link } = relay("?state=one&state=two&code=a%2Bb&picked_file_ids=first&picked_file_ids=second");
		const url = new URL(link.href);
		expect(url.searchParams.getAll("state")).toEqual(["one", "two"]);
		expect(url.searchParams.getAll("picked_file_ids")).toEqual(["first", "second"]);
		expect(url.searchParams.get("code")).toBe("a+b");
		expect(url.hash).toBe("");
	});

	it("does not automatically open a callback without correlated code or error", () => {
		expect(relay("").replace).not.toHaveBeenCalled();
		expect(relay("?code=unrelated").replace).not.toHaveBeenCalled();
		expect(relay("?state=unrelated").replace).not.toHaveBeenCalled();
		expect(relay("?state=expected&error=access_denied").replace).toHaveBeenCalledOnce();
	});

	it("has no network, external script, storage, analytics, or secret rendering", () => {
		expect(html).not.toMatch(/<script[^>]+src=|<iframe|<img|fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|innerHTML|textContent/);
		expect(html).toContain('name="referrer" content="no-referrer"');
		const digest = createHash("sha256").update(script!).digest("base64");
		expect(html).toContain("script-src 'sha256-" + digest + "'");
		expect(html).toContain("default-src 'none'");
		expect(html).toContain('id="open-obsidian"');
	});

	it("pins the deployed URI and excludes retired Google worker/token relay production paths", () => {
		expect(DEFAULT_CUSTOM_REDIRECT_URI).toBe("https://momoan01.github.io/momoan-sync/oauth-callback/");
		for (const file of ["src/backends/googledrive/auth.ts", "src/backends/googledrive/module.ts", "src/backends/shared/auth-config.ts", "site/oauth-callback/index.html", "e2e/google-picker/google-picker.interactive.ts", "e2e/google-picker/oracle.ts"]) {
			const source = readFileSync(file, "utf8");
			expect(source).not.toMatch(/auth-airsync\.takezo\.dev|https:\/\/airsync\.takezo\.dev\/callback|obsidian:\/\/air-sync-auth/);
		}
	});
});
