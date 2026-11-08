import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCommand, installCommand, uninstallCommands, countChanges, installSummary } from '../../src/install.js';

test('splitCommand handles quoted, unquoted-with-spaces and bare commands', () => {
  assert.deepEqual(splitCommand('"C:\\Program Files\\App\\unins000.exe" /SILENT'), { file: 'C:\\Program Files\\App\\unins000.exe', args: '/SILENT' });
  assert.deepEqual(splitCommand('C:\\Program Files\\App\\uninstall.exe /S'), { file: 'C:\\Program Files\\App\\uninstall.exe', args: '/S' });
  assert.deepEqual(splitCommand('MsiExec.exe /X{1234}'), { file: 'MsiExec.exe', args: '/X{1234}' });
  assert.deepEqual(splitCommand('powershell -File x.ps1'), { file: 'powershell', args: '-File x.ps1' });
  assert.deepEqual(splitCommand('"C:\\unterminated'), { file: 'C:\\unterminated', args: '' });
  assert.deepEqual(splitCommand(''), { file: '', args: '' });
});

test('installCommand picks a silent command per installer type', () => {
  assert.deepEqual(installCommand('C:\\i\\a.msi', '', 'C:\\log.txt'), { file: 'msiexec.exe', args: '/i "C:\\i\\a.msi" /qn /norestart /l*v "C:\\log.txt"' });
  assert.equal(installCommand('C:\\i\\a.MSI', 'ADDLOCAL=ALL').args, '/i "C:\\i\\a.MSI" /qn /norestart ADDLOCAL=ALL');
  assert.equal(installCommand('C:\\i\\setup.ps1').file, 'powershell.exe');
  assert.equal(installCommand('C:\\i\\setup.cmd', '/q').args, '/d /s /c ""C:\\i\\setup.cmd" /q"');
  assert.deepEqual(installCommand('C:\\i\\setup.exe', '/S'), { file: 'C:\\i\\setup.exe', args: '/S' });
  assert.throws(() => installCommand('C:\\i\\setup.zip'), /Don't know how to run \.zip/);
});

const msi = { key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{23170F69-40C1-2702-2501-000001000000}', displayName: '7-Zip', windowsInstaller: '1', uninstallString: 'MsiExec.exe /I{23170F69-40C1-2702-2501-000001000000}' };
const nsis = { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\App', displayName: 'App', uninstallString: '"C:\\Program Files\\App\\uninstall.exe"' };

test('uninstallCommands prefers msiexec /x, then QuietUninstallString, then UninstallString + args', () => {
  assert.deepEqual(uninstallCommands([msi]), [{ file: 'msiexec.exe', args: '/x {23170F69-40C1-2702-2501-000001000000} /qn /norestart', program: '7-Zip', key: msi.key }]);
  assert.equal(uninstallCommands([{ ...nsis, quietUninstallString: '"C:\\x\\u.exe" /quiet' }], '/S')[0].args, '/quiet');
  assert.deepEqual(uninstallCommands([nsis], '/S')[0], { file: 'C:\\Program Files\\App\\uninstall.exe', args: '/S', program: 'App', key: nsis.key });
  assert.deepEqual(uninstallCommands([{ key: 'HKLM\\x\\NoCmd', displayName: 'nothing to run' }]), []);
});

test('uninstallCommands skips SystemComponent entries unless that is all there is', () => {
  const hidden = { ...nsis, key: 'HKLM\\x\\Hidden', displayName: 'Runtime', systemComponent: 1 };
  assert.deepEqual(uninstallCommands([hidden, msi]).map((c) => c.program), ['7-Zip']);
  assert.deepEqual(uninstallCommands([hidden]).map((c) => c.program), ['Runtime']);
});

const emptyDiff = () => ({
  files: { added: [], removed: [], changed: [], addedCount: 0, removedCount: 0, changedCount: 0, addedBytes: 0 },
  registry: { added: [], removed: [], addedCount: 0, removedCount: 0 },
  values: [], services: [], programsAdded: [], programsRemoved: [],
});

test('countChanges sums every kind of change', () => {
  assert.equal(countChanges(null), 0);
  assert.equal(countChanges(emptyDiff()), 0);
  const d = emptyDiff();
  d.files.addedCount = 3; d.registry.removedCount = 2; d.values.push({}); d.services.push({}); d.programsAdded.push({});
  assert.equal(countChanges(d), 8);
});

test('installSummary reads like a verdict', () => {
  const d = emptyDiff();
  d.programsAdded.push({ displayName: 'LeakyApp' }); d.files.addedCount = 5;
  const text = installSummary({
    pass: false, installer: 'install.ps1', seconds: 97.2, failures: ['uninstall left 8 change(s) behind'],
    install: { exitCode: 0, seconds: 3.1 }, installDiff: d, uninstalls: [{ program: 'LeakyApp', exitCode: 0, seconds: 1.2 }],
    leftovers: emptyDiff(), leftoverCount: 8, reportPath: 'C:\\r\\report.md',
  });
  assert.match(text, /^FAIL {2}install\.ps1 on a fresh Windows Sandbox \(97\.2s\)/);
  assert.match(text, /why +uninstall left 8 change\(s\) behind/);
  assert.match(text, /added +LeakyApp; 5 files, 0 registry keys/);
  assert.match(text, /uninstall +LeakyApp: exit 0/);
  assert.match(text, /leftovers +8 change\(s\) left behind/);
});
