// The guest agent runs on Windows PowerShell 5.1, whose Add-Type only compiles C# 5. Catch syntax slips on the host
// instead of in a sandbox that takes 15 s to boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from '../../src/core.js';

const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 120_000 });
const agent = (f) => path.join(ROOT, 'agent', f);

test('agent PowerShell files parse', () => {
  const files = fs.readdirSync(path.join(ROOT, 'agent')).filter((f) => /\.ps(m?)1$/i.test(f));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const out = ps(`$e = $null; [void][Management.Automation.Language.Parser]::ParseFile('${agent(f)}', [ref]$null, [ref]$e); ($e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }) -join [char]10`);
    assert.equal(out.trim(), '', `${f} has parse errors`);
  }
});

test('snap.cs compiles with Windows PowerShell 5.1 (C# 5)', () => {
  const out = ps(`Add-Type -TypeDefinition ([IO.File]::ReadAllText('${agent('snap.cs')}')) -Language CSharp -ErrorAction Stop; [SbxSnap].Name`);
  assert.equal(out.trim(), 'SbxSnap');
});

test('uia.cs compiles against the UIAutomationCore interop', () => {
  const out = ps(`$m = Import-Module '${agent('SbxUi.psm1')}' -PassThru; & $m { Initialize-SbxUi }; [SbxUia].Name`);
  assert.equal(out.trim().split(/\r?\n/).pop(), 'SbxUia');
});

test('UIA uses inbox Framework references even when app cwd contains System.dll', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-uia-shadow-'));
  const quote = (s) => `'${s.replace(/'/g, "''")}'`;
  try {
    ps(`Add-Type -TypeDefinition 'public class AppLocalFacade {}' -OutputAssembly ${quote(path.join(dir, 'System.dll'))}`);
    const out = ps(`Set-Location ${quote(dir)}; Import-Module ${quote(agent('SbxUi.psm1'))}; Initialize-SbxUi; [SbxUia].Name`);
    assert.equal(out.trim().split(/\r?\n/).pop(), 'SbxUia');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('desktop probe compiles on PowerShell 5.1 and secure-desktop guard fails closed', () => {
  const out = ps(`. '${agent('desktop.ps1')}'; function Get-DesktopFacts { @{ ready = $false; inputDesktop = 'Winlogon' } }; try { Assert-InteractiveDesktop; throw 'guard unexpectedly passed' } catch { $_.Exception.Message }`);
  assert.match(out, /desktop not interactive \(locked \/ secure desktop \/ UAC\)/);
});

test('capture click rejects moved windows before delivering input', () => {
  const out = ps(`
    Add-Type -Namespace Sbx -Name Native -MemberDefinition 'public static bool IsWindow(System.IntPtr h) { return true; } public static bool IsIconic(System.IntPtr h) { return false; }';
    $ast = [Management.Automation.Language.Parser]::ParseFile('${agent('agent.ps1')}', [ref]$null, [ref]$null);
    $fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Op-Click' }, $true);
    . ([ScriptBlock]::Create($fn.Extent.Text));
    function Get-WindowBounds { @{ Left=10; Top=0; Right=110; Bottom=100 } }
    $script:captures = @{ old = @{ windowHandle='1234'; left=0; top=0; width=100; height=100 } };
    try { Op-Click ([pscustomobject]@{ captureId='old' }); throw 'input delivered unexpectedly' } catch { $_.Exception.Message }
  `);
  assert.match(out, /Captured window moved, resized, minimized or closed/);
});
test('capture guard rejects a desktop transition or changed display bounds', () => {
  const out = ps(`
    . '${agent('desktop.ps1')}';
    function Get-DesktopFacts { @{ ready=$true; left=0; top=0; width=100; height=100 } }
    foreach ($before in @(
        @{ ready=$false; left=0; top=0; width=100; height=100 },
        @{ ready=$true; left=0; top=0; width=101; height=100 }
    )) {
        try { Assert-CaptureDesktop $before; throw 'capture guard unexpectedly passed' } catch { $_.Exception.Message }
    }
  `);
  assert.equal(out.trim().split(/\r?\n/).filter((line) => line.includes('display bounds changed')).length, 2, out);
});