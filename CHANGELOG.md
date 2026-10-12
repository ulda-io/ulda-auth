# Changelog

## 1.0.1

- Fix the release dry-run for versions already present in npm, with regression tests for dry-run safety and archive integrity.
- Clarify GitHub Actions rehearsals, trusted publisher configuration and maintainer approval in the publishing guide.
- SDK runtime, public API, wire protocol, cryptographic profile and dependencies are unchanged from 1.0.0.

## 1.0.0

- Initial public SDK package: encrypted master/content lifecycle over ULDA and Socket.IO.
- Per-resource chains, binary transport, subscriptions, X/S queues and explicit conflict handling.
- Bounded reconnect with verified reads; no automatic replay of uncertain writes.
- Fail-closed incoming validation, explicit content recovery and private secret lifecycle.
- ESM and standalone browser exports, TypeScript declarations and pinned core dependency.
- Security regressions, safe test output, package checks and publication dry-run.
