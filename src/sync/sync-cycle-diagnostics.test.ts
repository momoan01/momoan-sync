import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import type { ChangeSet } from "./change-detector";
import { logChangeDetection } from "./sync-cycle-diagnostics";

function fixture(count = 1): ChangeSet {
	return {
		temperature: "cold", candidateFacts: [], identityEvidence: [],
		entries: Array.from({ length: count }, (_, index) => ({
			path: "old-" + index + ".md",
			local: { path: "old-" + index + ".md", pathAuthority: "actual_resolved" as const,
				isDirectory: false, size: 4, mtime: 1, hash: "changed", backendMeta: { token: "secret" } },
			prevSync: { path: "old-" + index + ".md", hash: "original", localMtime: 1,
				remoteMtime: 1, localSize: 4, remoteSize: 4, syncedAt: 1, remoteIdentityKey: "X" + index },
		})),
		observations: [
			{ kind: "absent", side: "remote", requestedPath: "old-0.md", authority: "stat" },
			{ kind: "unknown", side: "local", requestedPath: "old-0.md", reason: "not_observed" },
		],
	};
}
function logger(enabled = true) {
	const debug = vi.fn<(message: string, data?: Record<string, unknown>) => void>();
	return { debug, value: { enabled: () => enabled, info: vi.fn(), debug } as unknown as Logger };
}

describe("tracked local-only observation diagnostics", () => {
	it("reports exact absence authority and baseline mismatch without changing facts or leaking metadata", () => {
		const changes = fixture(); const original = JSON.stringify(changes); const log = logger();
		logChangeDetection(changes, new Map(), log.value);
		expect(log.debug).toHaveBeenCalledWith("Tracked local-only observations", {
			entries: [{ path: "old-0.md",
				local: { path: "old-0.md", pathAuthority: "actual_resolved", size: 4,
					hashKnown: true, baselineHashMatches: false },
				baseline: { path: "old-0.md", remoteIdentityKey: "X0" }, currentRemotePaths: [],
				observations: changes.observations,
			}], truncated: 0,
		});
		expect(JSON.stringify(log.debug.mock.calls)).not.toContain("secret");
		expect(JSON.stringify(changes)).toBe(original);
	});
	it("does not build or emit diagnostic detail when debug is disabled", () => {
		const changes = fixture(); const log = logger(false);
		const observations = vi.spyOn(changes.observations, "filter");
		logChangeDetection(changes, new Map(), log.value);
		expect(log.debug).not.toHaveBeenCalled(); expect(observations).not.toHaveBeenCalled();
	});
	it("caps tracked entry details and reports truncation", () => {
		const changes = fixture(30); const log = logger();
		logChangeDetection(changes, new Map(), log.value);
		const call = log.debug.mock.calls.find(item => item[0] === "Tracked local-only observations");
		if (!call) throw new Error("Missing diagnostic");
		expect(call[1]?.entries).toHaveLength(25); expect(call[1]?.truncated).toBe(5);
	});
});
