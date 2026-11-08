import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activationTarget, isPackage, packageInputs } from '../../src/packaged.js';
import { ROOT } from '../../src/core.js';
import { renderReport } from '../../src/run.js';

test('packaged run report preserves installation identity', () => {
  const report = renderReport({
    app: 'demo.msix', hostDir: 'C:\\build', outDir: 'C:\\out', pass: true, mode: 'gui',
    seconds: 30, startedAt: '2026-11-07', shots: [], collected: [], errors: [], crashes: [],
    package: { packageFullName: 'Demo_1_x64', aumid: 'Demo_123!App' },
  });
  assert.match(report, /\| Package \| `Demo_1_x64` \|\n\| AUMID \| `Demo_123!App` \|/);
});

test('package extensions and AUMID activation preserve the executable path', () => {
  for (const ext of ['msix', 'MSIXBUNDLE', 'appx', 'appxbundle']) assert.ok(isPackage(`demo.${ext}`));
  assert.equal(isPackage('demo.exe'), false);
  assert.deepEqual(activationTarget({ path: 'C:\\apps\\demo.exe' }), { path: 'C:\\apps\\demo.exe' });
  assert.deepEqual(activationTarget({ path: 'C:\\apps!\\demo.exe' }), { path: 'C:\\apps!\\demo.exe' });
  for (const input of [{ aumid: 'Demo_123!App' }, { path: 'Demo_123!App' }, { path: 'shell:AppsFolder\\Demo_123!App' }])
    assert.deepEqual(activationTarget(input), { aumid: 'Demo_123!App' });
  assert.throws(() => activationTarget({}), /Specify/);
  assert.throws(() => activationTarget({ aumid: 'C:\\app.exe' }), /AUMID/);
  assert.throws(() => activationTarget({ aumid: 'Demo!App!Other' }), /AUMID/);
  assert.throws(() => activationTarget({ aumid: '' }), /AUMID/);
});

test('package inputs validate before boot and discover adjacent dependency packages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-package-'));
  try {
    fs.mkdirSync(path.join(dir, 'deps'));
    for (const f of ['runtime.appx', 'framework.msix', 'readme.txt']) fs.writeFileSync(path.join(dir, 'deps', f), '');
    const app = path.join(dir, 'demo.msix');
    assert.deepEqual(packageInputs({ app }).dependencies.map((f) => path.basename(f)), ['framework.msix', 'runtime.appx']);
    assert.throws(() => packageInputs({ app, cert: path.join(dir, 'missing.cer') }), /Certificate/);
    assert.throws(() => packageInputs({ app, deps: path.join(dir, 'absent') }), /Dependency folder/);
    assert.throws(() => packageInputs({ app, console: true }), /AUMID/);
    assert.equal(packageInputs({ app: 'demo.exe' }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const q = (s) => `'${s.replace(/'/g, "''")}'`;
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
  { encoding: 'utf8', timeout: 120_000 }).trim();

test('packaged activation helper compiles with guest C# 5', () => {
  assert.equal(ps(`Add-Type -Path ${q(path.join(ROOT, 'agent', 'activation.cs'))}; [SbxActivation].Name`), 'SbxActivation');
});

test('package and bundle manifests resolve registered AUMIDs, arguments and deployment diagnostics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-manifest-'));
  try {
    const result = ps(`
      $ErrorActionPreference = 'Stop'
      . ${q(path.join(ROOT, 'agent', 'package.ps1'))}
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $file = ${q(path.join(dir, 'demo.msix'))}
      function Get-AppxPackage {
        [pscustomobject]@{Name='Demo'; Publisher='CN=Other'; Version='1.0.0.0'; Architecture='X64'; PackageFullName='WrongPublisher'; PackageFamilyName='Wrong_123'}
        [pscustomobject]@{Name='Demo'; Publisher='CN=Demo'; Version='2.0.0.0'; Architecture='X64'; PackageFullName='WrongVersion'; PackageFamilyName='Wrong_456'}
        [pscustomobject]@{Name='Demo'; Publisher='CN=Demo'; Version='1.0.0.0'; Architecture='X86'; PackageFullName='WrongArchitecture'; PackageFamilyName='Wrong_789'}
        [pscustomobject]@{Name='Demo'; Publisher='CN=Demo'; Version='1.0.0.0'; Architecture='X64'; PackageFullName='Demo_1_x64'; PackageFamilyName='Demo_123'; InstallLocation='C:\\Apps\\Demo'}
      }
      function Get-AppxPackageManifest { param($Package)
        if ($Package -ne 'Demo_1_x64') { throw "Resolved incorrect package: $Package" }
        [xml]'<Package><Applications><Application Id="One" Executable="Demo.exe"/><Application Id="Two" Executable="Other.exe"/></Applications></Package>'
      }
      function Import-Certificate { param($FilePath, $CertStoreLocation) $script:store = $CertStoreLocation }
      function Add-AppxPackage { param($Path, $DependencyPath, $ErrorAction)
        if ($script:fail) { throw 'HRESULT 0x80073CF3 ActivityId 12345678-1234-1234-1234-123456789012' }
        $script:deps = $DependencyPath
      }
      function Get-AppPackageLog { param($ActivityID, $ErrorAction) "Missing dependency: $ActivityID" }
      $answers = @()
      foreach ($entryName in @('AppxManifest.xml', 'AppxMetadata/AppxBundleManifest.xml')) {
        $zip = [IO.Compression.ZipFile]::Open($file, 'Create')
        $writer = New-Object IO.StreamWriter($zip.CreateEntry($entryName).Open())
        if ($entryName -like '*Bundle*') {
          $writer.Write('<Bundle xmlns="urn:demo"><Identity Name="Demo" Publisher="CN=Demo" Version="3.0.0.0"/><Packages><Package Type="application" Architecture="x64" Version="1.0.0.0"/></Packages></Bundle>')
        } else {
          $writer.Write('<Package xmlns="urn:demo"><Identity Name="Demo" Publisher="CN=Demo" Version="1.0.0.0" ProcessorArchitecture="x64"/></Package>')
        }
        $writer.Dispose(); $zip.Dispose()
        $r = Install-SbxPackage -PackagePath $file -ApplicationId Two -CertificatePath demo.cer -DependencyPath @('runtime.appx')
        $answers += @{ aumid=$r.aumid; executable=$r.executable; store=$script:store; deps=@($script:deps) }
        try { Install-SbxPackage -PackagePath $file; throw 'expected ambiguity' }
        catch { if ($_.Exception.Message -notlike '*--app-id*') { throw } }
        $script:fail = $true
        try { Install-SbxPackage -PackagePath $file -ApplicationId Two; throw 'expected deployment failure' }
        catch { if ($_.Exception.Message -notlike '*0x80073CF3*Missing dependency*') { throw } }
        $script:fail = $false
        Remove-Item -LiteralPath $file
      }
      ConvertTo-Json -InputObject $answers -Depth 5 -Compress
    `);
    const answers = JSON.parse(result);
    assert.equal(answers.length, 2);
    for (const r of answers) {
      assert.equal(r.aumid, 'Demo_123!Two');
      assert.equal(r.executable, 'Other.exe');
      assert.equal(r.store, 'Cert:\\LocalMachine\\TrustedPeople');
      assert.deepEqual(r.deps, ['runtime.appx']);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
