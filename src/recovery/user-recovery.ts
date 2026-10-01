import { restoreRecoveryJournalEntryToDesktop, type RecoveryJournalRestoreResult } from "./desktop-restore";
import { RecoveryJournal } from "./journal";
import type { RecoveryJournalEntry } from "./types";

export interface RecoveryJournalEndpointSummary {
	readonly index: number;
	readonly side: "local" | "remote";
	readonly path: string;
	readonly size: number;
	readonly hasContent: boolean;
}

export interface RecoveryJournalEntrySummary {
	readonly id: string;
	readonly capturedAt: string;
	readonly actionType: RecoveryJournalEntry["actionType"];
	readonly disposition: RecoveryJournalEntry["disposition"];
	readonly endpoints: readonly RecoveryJournalEndpointSummary[];
}

export interface RestoreRecoveryJournalEntryRequest {
	readonly vaultId: string;
	readonly entryId: string;
	readonly endpointIndex: number;
	readonly vaultBasePath: string;
	readonly backupDirectory?: string;
	readonly restoreDirectory: string;
}

export async function listRecoveryJournalEntries(
	vaultId: string,
): Promise<readonly RecoveryJournalEntrySummary[]> {
	const journal = new RecoveryJournal(vaultId);
	try {
		const entries = await journal.listEntries();
		return entries
			.map(toSummary)
			.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
	} finally {
		await journal.close();
	}
}

export async function restoreRecoveryJournalEntry(
	request: RestoreRecoveryJournalEntryRequest,
): Promise<RecoveryJournalRestoreResult> {
	const journal = new RecoveryJournal(request.vaultId);
	try {
		const entry = (await journal.listEntries()).find((candidate) => candidate.id === request.entryId);
		if (!entry) throw new Error(`Recovery journal entry is unavailable: ${request.entryId}`);
		return await restoreRecoveryJournalEntryToDesktop({
			entry,
			endpointIndex: request.endpointIndex,
			vaultBasePath: request.vaultBasePath,
			backupDirectory: request.backupDirectory,
			restoreDirectory: request.restoreDirectory,
		});
	} finally {
		await journal.close();
	}
}

function toSummary(entry: RecoveryJournalEntry): RecoveryJournalEntrySummary {
	return Object.freeze({
		id: entry.id,
		capturedAt: entry.capturedAt,
		actionType: entry.actionType,
		disposition: entry.disposition,
		endpoints: entry.endpoints.map((endpoint, index) => Object.freeze({
			index,
			side: endpoint.side,
			path: endpoint.path,
			size: endpoint.entity.size,
			hasContent: !endpoint.entity.isDirectory && endpoint.content !== undefined,
		})),
	});
}
