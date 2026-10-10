# Publishing

Use this procedure to release the checked archive for `ulda-auth`. Package versions cannot be reused after publication.

## Repository and metadata

The package repository is `ulda-io/ulda-auth`. For a first upload, create an empty repository without adding a generated README, license or gitignore, then configure origin to its HTTPS Git URL.

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

## Authenticate and publish

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
$uldaArchive = './.local/release/' + $uldaPackage.name + '-' + $uldaPackage.version + '.tgz'
$uldaHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $uldaArchive).Hash.ToLowerInvariant()

if ($uldaReceipt.name -ne $uldaPackage.name -or
    $uldaReceipt.version -ne $uldaPackage.version -or
    $uldaReceipt.dryRun -ne $true -or
    $uldaReceipt.sha256 -ne $uldaHash) {
  throw 'Archive differs from the checked release.'
}

npm publish $uldaArchive --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/
~~~

Publishing the tarball with --ignore-scripts preserves the checked artifact instead of rebuilding from the working directory. The configured dry-run check currently accepts stable numeric versions and the latest tag; prereleases need an intentional version/tag policy change.

After publication, compare npm's `dist.integrity` for that exact version with the saved receipt. Record the release and create its annotated tag on the checked commit. Any change to published contents requires a new version.

## Automation

The check workflow has read-only permissions and does not publish. A future publishing workflow can use npm Trusted Publishing with a narrowly configured GitHub Actions/OIDC identity instead of a long-lived token. Configure the registry side as well as the workflow and use the CLI/runtime versions required by npm.

References: [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/), [Trusted Publishers](https://docs.npmjs.com/trusted-publishers/).
