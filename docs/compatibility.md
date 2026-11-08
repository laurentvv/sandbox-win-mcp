# What has actually run in Windows Sandbox?

sandbox-mcp is framework-neutral: the input is a Windows executable, installer, script or app package, not a
WinUI project. That does **not** mean every Windows app can run in Sandbox. This page records concrete builds
and observations rather than turning a list of frameworks into a support guarantee.

## Measured results

Measured **2026-11-07 UTC** (2026-11-06 Pacific), Windows 11 guest **10.0.26100.0**, x64. Each measured row used its own
fresh guest, `--network off` (shared-folder mailbox), default five-second settle, a sample UIA test, screenshots
and application-error checks, followed by teardown. No SDK, shared modern .NET runtime, shared Windows App SDK
runtime or VC++ redistributable was installed in the guest. App-local self-contained payloads are part of the build.
Total time includes boot, copy/install, test and teardown, but not the host build.

| App type / sample | Packaging | Result | Boot / total | Evidence and notes |
|---|---|---|---|---|
| WinForms / HelloSandbox | .NET Framework 4.8 EXE | PASS | 15.6 / 41.9 s | [After test](compatibility/hello.png): type a name, invoke Greet, compare label with saved file. Uses inbox Framework. |
| WPF / Wpf | .NET 10.0.14 self-contained x64 EXE | PASS | 16.7 / 45.6 s | [After test](compatibility/wpf.png): invoke Greet, wait for the output TextBlock. |
| WinForms / WinForms | .NET 10.0.14 self-contained x64 EXE | PASS | 16.6 / 45.0 s | [After test](compatibility/winforms.png): invoke Greet, wait for the output label. |
| Native Win32 / NativeWin32 | x64 EXE, static CRT (`/MT`) | PASS | 16.1 / 41.6 s | [After test](compatibility/native.png): native button invocation and text assertion; no VC++ redist needed. |
| Native Win32 / NativeWin32 | Dev-signed MSIX, x64 | PASS | 18.0 / 48.2 s | [After test](compatibility/native-msix.png): guest-only public certificate trust, Add-AppxPackage, AUMID activation, same UIA test against the actual app PID. |
| WinUI 3 / HelloWinUI | .NET 10.0.14 + Windows App SDK 2.6.5 self-contained EXE | PASS | 14.4 / 42.7 s | [After test](compatibility/winui.png): greeting, counter and blank-name fallback through native UIA. |
| WinUI 3 / HelloWinUI | Same self-contained payload, dev-signed MSIX | PASS | 12.7 / 45.4 s | [After test](compatibility/winui-msix.png): `sandbox_run` over MCP, certificate trust, AUMID activation and the same UIA assertions. |
| Framework-dependent modern .NET variants of these samples | EXE plus explicitly provisioned runtime | Not measured for these exact variants | Not measured | The clean baseline deliberately does not install these runtimes; separate dependency fixtures were measured below. |

Passing rows have **three screenshots, UIA test exit 0, a live app window and zero matching crash events**.
The WinUI MSIX row exercised the MCP server end-to-end; the other rows used the CLI.
The [machine-readable observations](compatibility/results.json) contain exact times, separate Sandbox IDs,
test output, package identity when applicable and raw report locations relative to
`%LOCALAPPDATA%\sandbox-mcp-lanes\anyapp`. Screenshots here are downscaled to at most 600 pixels wide;
full-size PNGs remain beside each raw report.

Separate dependency fixtures demonstrated the opt-in provisioning flow in fresh network-off guests:
a framework-dependent .NET 10 WinForms app failed clean, then passed with Microsoft.WindowsDesktop.App
10.0.14; an MSVC `/MD` console app failed clean with missing VC++ DLLs, then passed with the Microsoft-signed
VC++ 14.51.36247 runtime. Windows App Runtime 1.8 was also explicitly installed in an existing offline guest;
package registration reported version 8000.921.1539.0 and persistent provenance marked the machine non-clean.
These observations establish those fixtures and provisioning paths, not an unmeasured pass for every sample variant.

Build host: Windows build 26340, Node 26.13.0, .NET SDK 10.0.403, Visual Studio x64 C++ tools and winapp CLI 0.7.1.
These are measured versions, not an exact-SDK requirement for using sandbox-mcp.

## Reproduce

Use the [source samples and build commands](../samples/README.md) from the matching release checkout
(`git checkout v1.2.0` for that release). Invoke `Wpf.exe`, `WinForms.exe` and
`HelloWinUI.exe` explicitly: self-contained .NET folders can contain `createdump.exe`, so a bare folder is
deliberately ambiguous. The entire folder is still copied when an EXE is selected.

```powershell
.\samples\Wpf\build.ps1
sbx run .\samples\Wpf\bin\publish\Wpf.exe --network off --test .\samples\Wpf\test.ps1

.\samples\NativeWin32\package.ps1
sbx run .\samples\NativeWin32\bin\NativeWin32.msix --cert .\samples\NativeWin32\bin\devcert.cer --network off --test .\samples\NativeWin32\test.ps1

pwsh -NoProfile -File .\samples\WinUI\build.ps1
sbx run .\samples\WinUI\bin\unpackaged\HelloWinUI.exe --network off --test .\samples\WinUI\test.ps1
sbx run .\samples\WinUI\bin\HelloWinUI.msix --cert .\samples\WinUI\bin\SandboxShowcase.cer --network off --test .\samples\WinUI\test.ps1
```

Dev-signing keys are generated under ignored `bin` folders, not checked in or trusted on the host. `--cert`
copies only the public CER into the disposable guest. Package dependency folders are explicit offline inputs;
these two MSIX samples are self-contained and have no external framework-package requirement.

## Failures found while building the fixtures

The initial WPF test found a real runner issue: PowerShell's UIA compiler resolved `System.dll` from the
self-contained app's working directory, finding a modern .NET facade instead of the inbox Framework assembly.
The runner now supplies explicit inbox Framework assembly paths, with a regression test. WPF and WinForms
subsequently passed with their actual self-contained working directories.

The initial WinUI distributions omitted `App.xbf`, `MainWindow.xbf` and the merged resource index during
publish, even though compilation produced them. Both variants installed/launched far enough to report a real
process, then failed in `Microsoft.UI.Xaml.dll` with a stowed exception. Including only the app XBFs was
insufficient: the [collected startup diagnostic](compatibility/winui-startup-failure.txt) identified the missing
WinUI theme resource. The sample now includes the merged index as `resources.pri`; build guards dump that index
and check the actual `Files/Microsoft.UI.Xaml/Themes/themeresources.xbf` entry in addition to the app XBFs.
A rebuilt payload was not treated as proof: both distributions were rerun in separate fresh guests and
passed the full UIA/screenshot/crash-check flow. The final table records those successful reruns; the
[initial failure records](compatibility/initial-winui-failures.json) are retained rather than erased.
This fixture defect is not evidence that WinUI itself is unsupported.

## Boundaries of this snapshot

- Live package checks exercised **MSIX**, guest-only development-certificate trust and full-trust desktop AUMIDs.
  Unit tests cover bundle manifest identities, offline dependency arguments, multiple Application Ids, publisher/
  version/architecture collisions and deployment-error activity logs. Appx and bundle extensions are accepted,
  but this snapshot does not claim a separate live run for every extension or every dependency graph.
- Console, Electron, PyInstaller, installers and detonation are valid entry-point categories, not extra passing
  rows inferred from these UI samples. Installer audit and detonation have separate tests and reports.
- No x86/Arm64, Store licensing, AppContainer-only, GPU/hardware integration, reboot-requiring installer or
  driver compatibility is established here. Such requirements need their own real guest proof.
- The default clean guest exposes missing dependencies. Provisioning is an explicit opt-in, not something a
  passing self-contained result implies was installed behind the scenes.

## Combined feature verification

The integration lane reran the combined runtime source at
`39da7ecd86599fc1c14d844c464068003bd0138e` on 2026-11-07 UTC, rather than treating component proofs as
integration acceptance. The original local-preview ZIP was separately parity-checked and exercised after
extraction with no host Node on PATH. These are historical measurements of that exact source, not a claim that
every later byte was tested then. Version 1.2.0 additionally fixes legitimate Windows 8.3 path spellings while
preserving reparse-point confinement; its hosted build checks source/package parity and published ZIP
verification requires a fresh bundled-runtime offline run as described in [releasing](../RELEASING.md).

| Combined check | Observed result |
|---|---|
| `node test\integration.js off`, `on`, `firewall` | PASS: real CLI + MCP stdio share one guest, concurrent encrypted exec/copy/readers, identity/tamper/replay/epoch/version rejection, UIA/greeting/PNG, six-frame recording, desktop-turn transfer, incremental deploy/no-change/mutation/delete/restart, owned teardown. |
| `node test\evidence.js` | PASS: on/off interactive readiness, explicit older capture, out-of-bounds/moved-window rejection, normal HTML/MP4 with ffmpeg decode, forced recorder interruption, and an 18-frame one-shot report. |
| Native `/MD` clean versus explicit auto provisioning | Clean FAIL naming missing VC++ (exit -1073741515, 29.8 s); explicit Microsoft-signed VC++ provisioning PASS (exit 0, 30.9 s). |
| Existing offline guest, explicit Windows App Runtime 1.8 | PASS: registered 8000.921.1539.0; persistent non-clean provenance retains VC++ and WAR installation records. |
| WinUI EXE, offline CLI + test + recording | PASS, 47.291 s; three screenshots, test exit 0, live window, no matching crashes. [Fresh screenshot](../docs/integration-winui.png). |
| WinUI MSIX, offline MCP `sandbox_run` + test + recording | PASS, 48.907 s; actual PID 1932, AUMID `SandboxShowcase.WinUI_nf4dxqg4mb6dm!App`, three screenshots, no matching crashes, 51-frame complete HTML/MP4. [Fresh screenshot](../docs/integration-winui-msix.png). |
| Self-contained WPF, offline CLI + test | PASS, 46.241 s; modern app-local assemblies do not shadow the inbox UIA compiler references. [Fresh screenshot](../docs/integration-wpf.png). |

Integration raw artifacts are under the lane-specific `work\integration-final\runs` in the verification
checkout (not a universal install path): recording one-shot `20261107-015719`, native clean `015755`,
native provisioned/WAR `015826`, WinUI EXE `015927`, WinUI MSIX `020023`, WPF `020118`.
Each GUI run's `out\report.json` includes test output, screenshots and timings; recording reports link
`out\recordings\<recordingId>\recording.html`, MP4 and raw manifest. See the final handoff for ZIP hash
and extracted-package run paths.

The 95 host/guest unit tests include same-provider-ID/different-epoch cleanup, two-writer state/provenance/
recording updates, retained publication recovery, rejected zero-frame start recovery, bounded manifest reads
and screenshot path-escape tripwires. **Actual UAC/lock transitions were not induced**; mocked native desktop
identity/bounds denial regressions cover the fail-closed guard. No blanket “all Windows apps work” claim is made.
