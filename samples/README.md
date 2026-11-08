# Small apps, real clean-machine tests

These are source samples, not preinstalled guest tooling. Build on the host, then copy only the output into a
fresh Sandbox with `sbx run`. All binaries and generated signing material belong under each sample's ignored
`bin` directory. Samples are in the source checkout, not the portable ZIP.

| Sample | Host build requirements | Guest payload |
|---|---|---|
| HelloSandbox | Inbox .NET Framework C# compiler | WinForms on inbox .NET Framework 4.8 |
| Wpf | .NET 10 SDK | Self-contained x64 WPF |
| WinForms | .NET 10 SDK | Self-contained x64 WinForms |
| NativeWin32 | Visual Studio C++ desktop tools | Native x64 Win32, static CRT (`/MT`) |
| WinUI | See its build script | Self-contained x64 WinUI 3, unpackaged and MSIX |

```powershell
.\samples\HelloSandbox\build.ps1
sbx run .\samples\HelloSandbox\bin --network off --test .\samples\HelloSandbox\test.ps1

.\samples\Wpf\build.ps1
sbx run .\samples\Wpf\bin\publish\Wpf.exe --network off --test .\samples\Wpf\test.ps1

.\samples\WinForms\build.ps1
sbx run .\samples\WinForms\bin\publish\WinForms.exe --network off --test .\samples\WinForms\test.ps1

.\samples\NativeWin32\build.ps1
sbx run .\samples\NativeWin32\bin\publish --network off --test .\samples\NativeWin32\test.ps1

# The same native executable, installed as a dev-signed MSIX (requires winapp CLI):
.\samples\NativeWin32\package.ps1
sbx run .\samples\NativeWin32\bin\NativeWin32.msix --cert .\samples\NativeWin32\bin\devcert.cer --network off --test .\samples\NativeWin32\test.ps1
```

Each UI test invokes **Greet** through UI Automation and waits for the greeting text. HelloSandbox also tests
typing and a file write. A test failure returns a nonzero exit code and the run's `report.md` / `report.json`
contain screenshots and diagnostics.

Self-contained is intentional: do not assume that a clean guest has a compatible modern .NET or Windows App SDK
application runtime. Observed inbox/CBS Windows App Runtime packages are not proof that an app's requested runtime
is present. Shipping an app-local self-contained payload is different from explicitly installing a runtime in
the guest. The [compatibility matrix](../docs/compatibility.md)
records exactly which builds were exercised; these samples are not a guarantee that every Windows app works.
