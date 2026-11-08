# Runs inside the sandbox at logon: polls C:\work\jobs for *.ps1, runs each, writes output + exit code.
$jobs='C:\work\jobs'; $res='C:\work\results'
"ready $(Get-Date -f o) $env:COMPUTERNAME" | Set-Content "$res\_ready.txt"
while ($true) {
  Get-ChildItem $jobs -Filter *.ps1 | ForEach-Object {
    $id=$_.BaseName; $out="$res\$id.out"
    try { & powershell -NoProfile -ExecutionPolicy Bypass -File $_.FullName *> $out; $code=$LASTEXITCODE } catch { $_ | Out-File $out -Append; $code=1 }
    "$code" | Set-Content "$res\$id.done"
    Remove-Item $_.FullName -Force
  }
  Start-Sleep -Milliseconds 500
}
