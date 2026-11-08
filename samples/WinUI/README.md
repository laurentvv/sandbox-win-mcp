# WinUI 3 source-only sample

One window: name → greeting, plus a two-click counter. Automation IDs:
`NameBox`, `GreetButton`, `Output`, `IncrementButton`, `Counter`.
`test.ps1` uses the imported SbxUi module and `SBX_APP_PID`; run it only in the guest.

## Build (host, no app launch)

Prerequisites: Windows x64; **.NET 10 SDK**; Visual Studio C++ x64 tools
and release CRT redistributable files; Windows SDK build tools; **winapp 0.7.1**.

```powershell
pwsh -NoProfile -File .\samples\WinUI\build.ps1
```

The script tries the local NuGet cache first, then NuGet.org, then
`https://packagefeedproxy.microsoft.io/nuget/v3/index.json`. Package versions
and their transitive closure are locked. Host builds were verified with SDK 10.0.403;
that exact SDK version is not required.
No template or restore-time floating package upgrades are needed for rebuilds.
The pinned Windows SDK's MakeAppx packs the published layout; `winapp sign`
signs it. This avoids `winapp package` 0.7.1 rewriting runtime dependencies.

Generated files (all ignored):

| Path below this directory | Purpose |
| --- | --- |
| `bin\unpackaged\HelloWinUI.exe` | Unpackaged x64 app; copy the **entire directory**, not just the EXE |
| `bin\HelloWinUI.msix` | Dev-signed x64 package, application ID `App` |
| `bin\SandboxShowcase.cer` | Public signing certificate for disposable guest trust via `--cert` |
| `bin\SandboxShowcase.pfx` | Development signing key, password `password`; never commit/distribute as a production key |
| `bin\package-layout` | Same self-contained app payload used for the package, plus generated logo/manifest |

Both distributions contain .NET, Windows App SDK, and app-local release VC CRT
DLLs: no guest runtime/VC-redist installer or framework MSIX is required.
`WindowsPackageType=None` intentionally produces an unpackaged payload; the same
bits also work with package identity thanks to the self-contained SDK's reg-free
WinRT initializer. No AI, notifications, or singleton runtime services are used.
The package declares only Windows.Desktop and runFullTrust, not framework
PackageDependency entries. Minimum OS is Windows 10 build 19041.

The certificate publisher is `CN=SandboxShowcase`, matching the package identity
`SandboxShowcase.WinUI` (version `1.0.0.0`). The build only generates/exports the
certificate and signs; it **does not install or trust anything on the host**.
The parent must trust the CER and install/activate the MSIX in the disposable
guest. Launch a packaged app by application identity, not by executing a file
under WindowsApps. The same guest test applies to either distribution.

This is a development signature without a timestamp, valid for 365 days.
The PFX is reused on rebuild; delete the ignored PFX and CER to regenerate it.
Build reproducibility means pinned inputs and repeatable commands, not
byte-identical signatures/certificates or CRTs across different VS installations.
No binaries or images are checked in: the package logo is generated during build.

## Run and test (from `samples\WinUI`)

Using the parent repository's `sbx` implementation:

```powershell
sbx run bin\HelloWinUI.msix --cert bin\SandboxShowcase.cer --network off --test test.ps1
sbx run bin\unpackaged\HelloWinUI.exe --network off --test test.ps1
```
