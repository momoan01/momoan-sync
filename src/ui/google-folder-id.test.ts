import { describe, expect, it } from "vitest";
import { parseGoogleFolderId } from "./google-folder-id";

describe("Google Drive folder ID parser", () => {
	it("accepts a trimmed Drive folder ID", () => {
		expect(parseGoogleFolderId(" 1TestDriveFolder_AAAA0000 ")).toBe("1TestDriveFolder_AAAA0000");
	});
	it("rejects missing, malformed and URL input", () => {
		for (const value of ["", "abc", "https://drive.google.com/drive/folders/abc", "abc/def"]) {
			expect(() => parseGoogleFolderId(value)).toThrow();
		}
	});
});
