import { describe, expect, it } from "vitest";
import orchestratorSource from "./orchestrator.ts?raw";

describe("Mass Change Guard safety ordering", () => {
	it("requires the local snapshot before recovery capture and execution", () => {
		const snapshot = orchestratorSource.indexOf("await requireMassChangeSafetySnapshot");
		const recovery = orchestratorSource.indexOf("await this.recoveryJournal.capturePlan");
		const execution = orchestratorSource.indexOf("await executePlan");

		expect(snapshot).toBeGreaterThan(-1);
		expect(recovery).toBeGreaterThan(snapshot);
		expect(execution).toBeGreaterThan(recovery);
	});
});
