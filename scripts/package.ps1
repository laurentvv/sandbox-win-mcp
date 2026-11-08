$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$distRoot = Join-Path $repoRoot 'dist'
$stage = Join-Path $distRoot 'sandbox-mcp'
$package = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$node = Get-Command node.exe -ErrorAction Stop
$nodeVersion = (& $node.Source --version).Trim()
$architecture = (& $node.Source -p 'process.arch').Trim()
$sourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify the package source commit.' }
$channel = if ($env:SANDBOX_MCP_BUILD_CHANNEL) { $env:SANDBOX_MCP_BUILD_CHANNEL } else { 'local-candidate' }

if ([int]($nodeVersion -replace '^v(\d+).*', '$1') -lt 20) {
  throw "Node.js 20 or later is required to build the package (found $nodeVersion)."
}
if ($architecture -ne 'x64') {
  throw "Only Windows x64 packages are currently supported (found $architecture)."
}
if (-not (Test-Path (Join-Path $repoRoot 'node_modules\@modelcontextprotocol\sdk\package.json'))) {
  throw 'Dependencies are missing. Run npm ci --omit=dev, then npm run package:win.'
}

$archive = Join-Path $distRoot "sandbox-mcp-win-x64-v$($package.version).zip"
New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

foreach ($item in @('src', 'agent', 'skills', 'docs', 'node_modules')) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $item) -Destination $stage -Recurse
}
foreach ($item in @('README.md', 'LICENSE', 'package.json')) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $item) -Destination $stage
}
Copy-Item -LiteralPath $node.Source -Destination (Join-Path $stage 'node.exe')
# Node installs don't reliably ship their LICENSE next to node.exe, so take the exact one for this version.
Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile (Join-Path $stage 'NODE-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'sbx.cmd') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'sandbox-mcp.cmd') -Destination $stage
@(
  "sandbox-mcp $($package.version)"
  'Platform: Windows x64'
  "Bundled runtime: Node.js $nodeVersion (license: NODE-LICENSE.txt)"
  "Source commit: $sourceCommit"
  "Build channel: $channel"
) | Set-Content -LiteralPath (Join-Path $stage 'BUILD-INFO.txt') -Encoding UTF8

Push-Location $stage
try {
  & (Join-Path $stage 'node.exe') --input-type=module -e "await import('@modelcontextprotocol/sdk/server/mcp.js'); await import('zod')"
  if ($LASTEXITCODE -ne 0) { throw 'The packaged MCP dependencies failed their import check.' }
}
finally {
  Pop-Location
}

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -CompressionLevel Optimal
Write-Output "Created $archive"
