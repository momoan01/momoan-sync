/** Translate Google module logical keys to Obsidian-compatible device secret IDs. */
export function resolveGoogleSecretId(logicalKey: string): string {
	return "momoan-sync-googledrive-" + logicalKey.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
}
