# Development

## Repository layout

| Path | Purpose |
|---|---|
| src/ | JavaScript runtime modules |
| types/index.d.ts | Public API declarations; no runtime implementation |
| tests/ | Synthetic tests and an in-memory Socket.IO fixture |
| scripts/ | Build, package, browser and secret-check tooling |
| docs/ | User reference documents and maintainer instructions |
| dist/ | Generated standalone browser ESM and license notices; ignored by Git |
| .local/ | Local package archives and check receipts; ignored by Git |

ULDA Core is a pinned dependency from npm. No neighboring project or copied core archive is required to build or unit-test the SDK.

## Install and check

~~~sh
npm ci --ignore-scripts
npm test
npm run test:types
npm run build
npm run test:bundle
npm run test:package
npm run test:publish
~~~

Or run `npm run release:check` for the local secret scan, tests, type checks, build, bundle check, clean-install package check and publication dry-run.

The browser build is ES2022 ESM. It includes the runtime dependencies and preserves their license texts. The Node entry imports the ESM modules directly.

The package check creates a tarball in .local/release, validates its exact file allowlist and document links, installs it into a separate temporary consumer, checks both exports and runs resource workflows. It does not publish.

## Additional integration checks

~~~sh
npm run test:package -- http://127.0.0.1:3000
npm run test:browser
~~~

The first command requires an already running compatible loopback server. It creates and deletes its own synthetic resources. It does not run recovery against that server because recovery preserves the previous resource.

The browser command requires installed Chrome and Edge. It uses new headless profiles and the packaged browser entry against a temporary fixture; it does not attach to personal browser sessions.

These commands record their target and archive SHA-256 in JSON receipts. A short lifecycle test is not a full compatibility, load or security audit.

## Synthetic data and diagnostic output

Tests must use synthetic data, not live master IDs, passwords, user payloads or production databases. The in-memory fixture is test infrastructure, not a production server.

`npm test` uses a reporter that shows pass/fail, file locations and totals while suppressing arbitrary test names, stdout/stderr, exception text, stack traces, diagnostic strings and assertion values. Using another reporter can expose those values. This output policy is not a sandbox for malicious test code.

Do not upload raw wire captures, memory dumps or environment files as CI artifacts.

## Secret scanner and its exceptions

`npm run check:secrets` inspects current non-ignored files and all local Git blob/commit/tag objects, including deleted and unreachable objects. Supported archives are inspected with nesting and expansion limits; unsupported or malformed forms fail the check.

`scripts/secret-scan-allowlist.json` contains exact exceptions for deliberately synthetic test values. Each entry has:

- a rule name, such as literal-credential or url-credential;
- a SHA-256 fingerprint of the precise matched source text;
- the specific file paths where it is permitted;
- the reason the match was reviewed.

It contains no user password, account token or SDK key. Removing it while retaining the matching fixture history makes those synthetic strings fail the scan. Do not replace these entries with directory-wide ignores or use them to allow real secrets.

The file and scanner remain repository-only and are excluded from the npm package. The scanner is heuristic: unknown formats, obfuscation and arbitrary application data require human judgment.

## Changes and releases

Keep API documentation and declarations aligned with runtime behavior. Retain meaningful regression coverage for protocol, cryptography, concurrency and failure handling.

`npm audit` reports known dependency advisories; it does not audit the SDK's cryptographic design. A passing test suite likewise does not certify all deployments.

Use [Publishing](PUBLISHING.md) to distribute the exact checked archive. Builds, tests and the CI check workflow do not publish packages.
