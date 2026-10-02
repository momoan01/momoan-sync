# Backup lifecycle and mandatory snapshots

Status: Accepted — M5-C3-C

Startup uses workspace layout-ready and one session-local promise before ordinary
sync. Scheduler sync and file-open priority also enter the lifecycle gate. Interval
snapshots use an explicit whole-minute setting, disabled by default; overlapping
ticks are dropped. Browser timer overflow is normalized to disabled. Unload cancels
the timer and prevents queued callbacks from starting work. These background failures
warn and do not block ordinary sync. No retention policy or automatic GC is installed.

A HOT mass guard queues its existing full re-observation and carries the
mass_change_guard provenance into that attempt. An already COLD guarded destructive
plan uses recovery_cold. Neither trigger changes Admission. The mandatory snapshot
still precedes Safety Journal capture and execution; unavailable or failed snapshots
remain permanent failures. Ordinary cold plans and Shadow previews do not take these
safety snapshots.

SyncStateStore's existing drop/recreate schema seam has an IDBHelper destructive-upgrade
preflight. An unversioned open reads an existing database version without changing it;
a new-database probe aborts its upgrade transaction, then permits ordinary creation.
An old existing version requires a successful schema_migration snapshot before the
target-version open. Actual upgrade oldVersion must equal the attempt-local observation;
mismatch aborts before onUpgrade. No asynchronous filesystem work runs inside upgrade
transactions, and failed proof cannot be reused on another open attempt.

Internal database audit: MetadataStore discards only a re-derivable remote projection
and cursor, causing ordinary full re-observation; it retains no unique user bytes or
SyncRecord merge bases. Its cache-only rebuild remains outside the snapshot requirement.
RecoveryJournal's version-1 setup adds an absent store and does not drop existing
recovery material. SyncStateStore is the actual destructive user-relevant durable-state
seam and remains the same publication owner. No DB_VERSION bump, new persistent owner,
provider mutation, sync algorithm, or stale-checkpoint hotfix change is made here.
