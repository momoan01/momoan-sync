# Momoan Sync

Personal-use Obsidian synchronization project.

- Bring your own Google OAuth is the target authentication model.
- No central Momoan account or sync server.
- No telemetry.
- No support guarantee.
- Use at your own risk.
- Fork and customize freely.

## Origin and license

Momoan Sync is derived from **Air Sync 0.2.1** at commit `3823b2282439aa03c99b30a579a9b3c38d250fba` by Takehito Gondo and is used under the MIT License. The upstream `LICENSE` and copyright notice are retained.

Momoan Sync is a separate project and is not affiliated with or supported by the Air Sync maintainer.

## Bootstrap status

M1 separates project identity, Obsidian protocol namespaces, and plugin-private log/conflict storage. The upstream sync decision engine is intentionally unchanged. Google-only BYO OAuth, Shadow Mode, Drive Trash deletion, recovery safeguards, backup, and Todo/widget integration are later milestones.

Do not use this M1 bootstrap against a production Vault. Live authentication is finalized in M2.
