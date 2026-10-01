import type { SyncAction } from "./types";

/** External user-data effects that require a durable recovery capture first. */
export function requiresRecoveryCapture(action: SyncAction): boolean {
	switch (action.action) {
		case "push":
			return action.remote !== undefined;
		case "pull":
			return action.local !== undefined;
		case "delete_local":
		case "delete_remote":
		case "rename_local":
		case "rename_remote":
		case "conflict":
			return true;
		case "match":
		case "cleanup":
			return false;
	}
}

export function isTopologyRewriteAction(action: SyncAction): boolean {
	return action.action === "delete_local" || action.action === "delete_remote" ||
		action.action === "rename_local" || action.action === "rename_remote";
}
