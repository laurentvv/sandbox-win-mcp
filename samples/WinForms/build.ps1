$ErrorActionPreference = 'Stop'
dotnet publish "$PSScriptRoot\WinForms.csproj" -c Release -o "$PSScriptRoot\bin\publish"
if ($LASTEXITCODE) { throw "dotnet publish failed ($LASTEXITCODE)" }
"$PSScriptRoot\bin\publish\WinForms.exe"
