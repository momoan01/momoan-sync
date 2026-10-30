# Momoan Sync

Personal-use Obsidian synchronization project focused on user-owned cloud data and conservative synchronization.

## Current scope

This repository maintains the standalone sync plugin. It remains separate from Momoan Todo and the Core development environment. Repository cleanup does not migrate vault data, change authentication, publish a release, or replace an installed plugin.

The main branch contains Google OAuth work, Shadow preview, recovery material, and mass-change safeguards beyond the original M1 bootstrap. Their boundaries are described in the architecture and agent guides; their presence is not proof that every provider, mobile device, or folder operation is verified for production.

- Shadow observes and reports without publishing sync state or executing the planned writes.
- Recovery material is retained separately from sync authority. It is not a replacement source of truth or an automatic replay queue.
- Live cloud E2E is opt-in and credential-gated. Run it only against a separately authorized test environment.
- No central Momoan account or sync server; no telemetry; no support guarantee. Back up important data before updating an installed plugin or enabling Write.

## Documentation

| Need | Entry point |
|---|---|
| Architecture and data ownership | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Sync pipeline | [docs/sync-pipeline.md](docs/sync-pipeline.md) |
| Development workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Agent rules and safety boundaries | [AGENTS.md](AGENTS.md) |
| Enforced checks | [docs/code-enforcement.md](docs/code-enforcement.md) |
| Opt-in live E2E | [docs/e2e-testing.md](docs/e2e-testing.md) |

## Development

Use npm and the committed lockfile. Do not commit generated main.js or node_modules.

```sh
npm ci
npm run dev
```

The repository gate is:

```sh
npm run lint
npm run lint:bot-repro
npm run build
npm run test:coverage
```

These checks do not establish real-device synchronization or permission to run against an operational vault. A documentation change does not bump the plugin version or create a release tag.

## Branches

main is the baseline. The existing diagnostic/local-only-observation and feat/mobile-directory-integration-20261016 branches contain changes not yet merged into main. Preserve them for separate review; repository cleanup does not merge or discard that work.

## Origin and license

Momoan Sync is derived from **Air Sync 0.2.1** at commit `3823b2282439aa03c99b30a579a9b3c38d250fba` by Takehito Gondo and is used under the MIT License. The upstream [LICENSE](LICENSE) and copyright notice are retained.

Momoan Sync is a separate project and is not affiliated with or supported by the Air Sync maintainer. Fork and customize freely; use at your own risk.
