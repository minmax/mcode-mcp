# Releases

GitHub Actions publishes tags matching `v*` through `.github/workflows/publish.yml`.
The tag must match `package.json`; `prepublishOnly` rebuilds and runs all checks.
Node 24 and the current npm CLI run on a GitHub-hosted Ubuntu runner.

Before the first automated release, publish the initial package with an authenticated
maintainer account and configure npm package Settings -> Trusted Publisher:

- Provider: GitHub Actions
- Organization or user: `minmax`
- Repository: `mcode-mcp`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Allow direct publishing with `npm publish`

Do not add an npm token to GitHub secrets. Once trust is configured, release with
`npm version patch` followed by `git push origin main --follow-tags`.
Verify the Actions run and the actual version on the npm registry separately.

Setup is not complete until the publisher is saved on npm and a tag release is verified.
See https://docs.npmjs.com/trusted-publishers/ for current requirements.
