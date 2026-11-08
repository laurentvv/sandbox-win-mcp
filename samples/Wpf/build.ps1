$ErrorActionPreference = 'Stop'
dotnet publish "$PSScriptRoot\Wpf.csproj" -c Release -o "$PSScriptRoot\bin\publish"
if ($LASTEXITCODE) { throw "dotnet publish failed ($LASTEXITCODE)" }
"$PSScriptRoot\bin\publish\Wpf.exe"
