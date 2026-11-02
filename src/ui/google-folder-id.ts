/** Validate a user-provided Google Drive folder ID without accepting arbitrary URLs. */
export function parseGoogleFolderId(value: string): string {
	const id = value.trim();
	if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new Error("Enter a valid Google Drive folder ID.");
	return id;
}
