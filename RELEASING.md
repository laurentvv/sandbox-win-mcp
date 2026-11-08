# Releasing

A release is a tag plus a Windows x64 portable ZIP (bundled Node, `sbx`, the MCP server, guest agent and skills).
GitHub Actions builds and attaches the ZIP; nothing is uploaded by hand.

## Verify the build before publication

Commit intended source/docs/screenshots and build with `npm run package:win`. For an optional local preview, copy the ZIP to
`sandbox-mcp-feature-preview-1.2.0-<short-commit>-win-x64.zip`.
Record the full commit and ZIP SHA256 alongside real run/report paths. A preview is not a published release;
do not imply that `/releases/latest` contains an unpublished build.

Run `node test\package-smoke.js <zip>` to compare shipped source/agent/skill bytes and CLI/MCP surfaces.
Extract that exact ZIP and run `test\integration.js` with its bundled `node.exe`, a fresh isolated
`SANDBOX_MCP_HOME`, `SANDBOX_MCP_TEST_ROOT`, `SANDBOX_MCP_TEST_SHA` and
`SANDBOX_MCP_EXPECT_NO_HOST_NODE=1`. Keep Windows system directories and the WindowsApps `wsb.exe` alias on
PATH but remove host Node. Verify owned-guest teardown. Hosted CI cannot provide this real desktop proof.
The compatibility screenshots and observations must describe tested builds, not unmeasured framework promises.
After an authorized feature-branch push, `gh workflow run release.yml --ref <branch>` provides a hosted build
without publishing. The workflow names its ZIP as a feature preview, includes a `.sha256` sidecar and source
commit/build channel in `BUILD-INFO.txt`, and uploads both as `sandbox-mcp-win-x64`. Download and verify that exact
artifact for the real extracted-package proof. A source push or successful manual build is not a release.
Published-release workflows also upload the checksum alongside the versioned ZIP.

## Publishing an authorized release

1. **Bump the version:** `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and the lockfile). Commit,
   push to `main` and wait for `ci` to go green.
2. **Dry run:** `gh workflow run release.yml`, then `gh run watch`. It runs the tests, builds the ZIP, smoke-tests it and
   keeps it as the `sandbox-mcp-win-x64` artifact. It never touches a release. Do this before every release: the
   hosted runner is the only place the packaged CLI is tested on a PC that isn't yours.
3. **Publish:** `gh release create vX.Y.Z --target main --title "..." --notes-file notes.md`. Publishing runs the
   workflow again, which refuses to upload unless the tag equals `v<package.json version>`, then attaches
   `sandbox-mcp-win-x64-vX.Y.Z.zip`.
4. **Check the asset:** download `releases/latest/download/sandbox-mcp-win-x64-vX.Y.Z.zip`, compare its SHA256 with the
   digest GitHub shows, and run `node test/package-smoke.js <zip>`. Then do one real run, because CI can't boot a
   sandbox: extract it, take Node off PATH, and `sbx run C:\Windows\System32\charmap.exe --open`.

Roll back a bad release with `gh release delete vX.Y.Z --cleanup-tag --yes`.

## Things that have bitten us

- **The CI runner is Windows Server, not Windows Pro.** It has no Windows Sandbox and no `wsb`, so `sbx doctor` must
  degrade gracefully there. The first dry run caught `doctor --json` printing nothing on the runner.
- **Keep the readiness probe in `src/core.js` to one PowerShell statement per fact.** It runs under
  `$ErrorActionPreference = 'SilentlyContinue'`, where one failing element inside a single `[ordered]@{...}` literal
  silences the whole output. An optional value written as `$(if (...) { ... })` serializes as `{}` when empty, which
  is truthy in JS; assign it inside the `if` instead.
- Only Windows x64 is tested natively. There is no ARM64 package.
