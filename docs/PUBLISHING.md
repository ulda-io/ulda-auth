# Publishing

Use this procedure to release the checked archive for `ulda-auth`. Package versions cannot be reused after publication.

## Repository and metadata

The package repository is `ulda-io/ulda-auth`. Its origin is `https://github.com/ulda-io/ulda-auth.git`.

Review the selected branch, its history, package metadata and license notices. Push the intended branch only; do not use --mirror or --all to upload unrelated local refs.

~~~sh
git status --short
git remote -v
git push -u origin main
~~~

Check the GitHub workflow results. Enable private vulnerability reporting if it is to be offered alongside the security email contact. Repository ownership does not grant npm publishing rights.

## Prepare the artifact

Set the intended version in package.json and package-lock.json. Update the changelog and applicable API/protocol documentation.

~~~sh
npm ci --ignore-scripts
npm run release:check
npm run test:package -- http://127.0.0.1:3000
npm run test:browser
npm run test:publish
~~~

The integration command needs a running compatible local server; the browser command needs Chrome and Edge. Record which checks and deployment acceptance apply to the release.

The .local/release receipts must refer to the same SHA-256. If a packaged file changes, rebuild and repeat the relevant package checks. Keep release evidence outside user documentation and do not upload raw test diagnostics.

`test:publish` verifies the archive against package-check.json and package.json, then invokes npm with --dry-run --ignore-scripts. It never performs an actual publish and does not confirm account permissions or reserve the package name.

## First publication: authenticate and publish

The package must already exist in npm before a trusted publisher can be configured. A local `npm login` does not authorize GitHub Actions. For a new name, use a one-time interactive publication of the accepted archive, then enable OIDC for subsequent versions. Do not create an empty placeholder release with the intended production version.

Authenticate interactively with the npm account that is authorized to publish:

~~~sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
~~~

Do not put credentials or one-time codes in source, issues or release notes. GitHub and npm account permissions are separate.

After accepting the release artifact, verify and publish it from the repository root:

~~~powershell
$uldaPackage = Get-Content -Raw package.json | ConvertFrom-Json
$uldaReceipt = Get-Content -Raw .local/release/publish-check.json | ConvertFrom-Json
$uldaAccepted = Get-Content -Raw .github/npm-release.json | ConvertFrom-Json
$uldaArchive = './.local/release/' + $uldaPackage.name + '-' + $uldaPackage.version + '.tgz'
$uldaHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $uldaArchive).Hash.ToLowerInvariant()

if ($uldaReceipt.name -ne $uldaPackage.name -or
    $uldaReceipt.version -ne $uldaPackage.version -or
    $uldaAccepted.name -ne $uldaPackage.name -or
    $uldaAccepted.version -ne $uldaPackage.version -or
    $uldaReceipt.dryRun -ne $true -or
    $uldaReceipt.sha256 -ne $uldaHash -or
    $uldaAccepted.sha256 -ne $uldaHash) {
  throw 'Archive differs from the checked release.'
}

npm publish $uldaArchive --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/
~~~

Publishing the tarball with --ignore-scripts preserves the checked artifact instead of rebuilding from the working directory. The configured dry-run check currently accepts stable numeric versions and the latest tag; prereleases need an intentional version/tag policy change.

This is a real publication command. Complete the npm browser/2FA challenge yourself. After publication, compare npm's `dist.integrity` for that exact version with the saved receipt. A local first publication does not have GitHub Actions provenance. Any change to published contents requires a new version. Do not trigger the automated publisher for a version already published during bootstrap.

## GitHub Actions

Two workflows cover the release:

- `check.yml`: branch pushes and pull requests run the secret/history scan, tests, type checks, build, bundle checks, clean package installation, publish dry-run and production dependency audit. The matrix covers Node.js 22 and 24 on Ubuntu and Windows. This workflow is also reusable by the release workflow.
- `publish.yml`: stable version tags such as `v1.0.1` run that same matrix, build and smoke-test the archive on Ubuntu, and match its SHA-256 against `.github/npm-release.json`. Only after those checks can the `npm` environment publish that exact artifact using npm Trusted Publishing (OIDC).

The publishing job has no repository checkout, dependency installation or lifecycle scripts. Only this job can request an OIDC token. It verifies the downloaded archive hash before publication and checks the registry integrity afterwards. Actions are pinned to commit hashes. No npm write token is stored in GitHub.

Tag releases must match `package.json`, `package-lock.json` and the accepted release record, and the commit must belong to `main`. Only stable versions with the `latest` tag are supported. Publication runs only from a public repository, matching the provenance-enabled release policy used by `ulda-core`.

For a rehearsal, select **Actions → Publish to npm → Run workflow → main**. A manual run executes the checks and uploads the archive and safe package receipts; it never publishes, including after npm authorization has been configured. Raw test logs and local credentials are not uploaded as artifacts. Artifacts are retained for seven days.

### Check CI without releasing another version

A change to this maintainer guide can exercise the pipeline without changing the npm package: this file is excluded from the archive. Commit the intended change, push `main`, and wait for all four **SDK checks** jobs. Then run the publication rehearsal:

~~~sh
gh workflow run publish.yml --repo ulda-io/ulda-auth --ref main
gh run list --repo ulda-io/ulda-auth --workflow publish.yml
~~~

For the selected commit, expect four successful test jobs, a successful **Prepare verified archive** job, and **Publish verified archive with OIDC** marked **skipped**. Download the archive and compare its SHA-256 with `.github/npm-release.json` and the accepted local archive.

This verifies CI, reproducible packaging and the publish dry-run. It does not exercise the npm OIDC exchange or prove permission to perform a real publication. Saving a trusted publisher or passing a dry-run does not establish that result either. Test actual publication only with an intentionally prepared new version and an authorized release tag; never reuse an already published version just to test the workflow.

If the first release used npm staged publishing, a public `0.0.0-stage` placeholder may remain in the version list. It is not an incomplete upload of the production release. Check the active version with `npm view ulda-auth dist-tags --json`; normal installation follows the `latest` tag. See [npm staged publishing](https://docs.npmjs.com/staged-publishing/).

### Accept the archive

After the applicable package, integration, fault and load checks, copy the accepted name, version, filename and SHA-256 from `.local/release/publish-check.json` into `.github/npm-release.json`. Review and commit this record with the release. It is outside the npm package, so changing it does not change the archive it identifies.

Do not replace the accepted hash merely to make CI pass: investigate any mismatch and repeat the relevant acceptance checks if packaged contents changed. A GitHub rehearsal must reproduce the accepted hash before publication.

### Configure npm and GitHub

After the package exists, configure **npm → ulda-auth → Settings → Trusted publishing → GitHub Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `ulda-io` |
| Repository | `ulda-auth` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Label, if offered | Optional descriptive text, such as `GitHub releases` |
| Allowed action | Direct publishing with `npm publish` |

Use the exact GitHub owner/repository identifiers above; the organization field here does not assign npm package ownership. The environment must match the workflow's `npm` value. With a compatible CLI (npm 11.15.0 or later), `npm trust list ulda-auth --json` reads the saved publisher configuration; it does not publish a package or validate an OIDC exchange.

Use the filename alone, not `.github/workflows/publish.yml`. npm requires a newly configured publisher to complete its first successful publication within two days; configure it close to the next release, or recreate an expired configuration. Successful configuration is not proof of successful publishing authorization.

In GitHub, configure **Settings → Environments → npm** with required maintainer review and a deployment policy that allows release tags (`v*`) only. Some protection rules depend on repository visibility and the GitHub plan. Confirm those rules before enabling releases. The workflow does not change repository visibility or create release tags by itself.

GitHub requires approval from one of the listed reviewers, not all of them. With **Prevent self-review** disabled, the person who initiated the deployment can approve it. These GitHub review permissions are separate from npm maintainer or organization-team permissions. See [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

### Subsequent releases

1. Prepare and accept the new archive, commit its release record, and push `main`.
2. Run the manual rehearsal and review its checks and archive hash.
3. Confirm the npm trusted publisher and GitHub `npm` environment settings.
4. Create an annotated `v<version>` tag on the accepted commit and push that tag only.
5. Approve the GitHub environment deployment, then check the workflow result and npm integrity.

The Node.js 24 publishing runner must provide npm 11.5.1 or later; the publishing job checks this requirement. The library retains its existing Node.js compatibility requirements.

If an npm command fails after upload, inspect the exact version in the registry first. Do not blindly retry a publication, move an already published tag or reuse the version. A failed integrity check after publication does not undo the upload.

References: [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/), [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
