// Real Windows Sandbox proof: supply a small MSVC /MD console exe using the VC++ standard library.
// The caller must acquire the shared Sandbox slot and set a lane-specific SANDBOX_MCP_HOME.
import assert from 'node:assert/strict';
import { runApp, summary } from '../src/run.js';
import { provisionSandbox } from '../src/provision.js';
import * as sbx from '../src/core.js';

const app = process.argv[2];
if (!app) throw new Error('Usage: node test\\deps-native-offline.js <VC++ /MD console exe>');
assert.ok(process.env.SANDBOX_MCP_HOME, 'Set an isolated SANDBOX_MCP_HOME before running live dependency tests.');

const clean = await runApp({ app, console: true, network: 'off', timeoutSec: 20 });
console.log(summary(clean));
assert.equal(clean.pass, false);
assert.ok(!clean.stopError, clean.stopError);
assert.deepEqual(await sbx.listSandboxes(), []);
assert.deepEqual(clean.provisioned, []);
assert.ok(clean.dependencyFindings.some((f) => f.component === 'VC++ redistributable'));

const provisioned = await runApp({ app, console: true, network: 'off', timeoutSec: 20, provision: 'auto', keep: true });
try {
  console.log(summary(provisioned));
  assert.equal(provisioned.pass, true);
  assert.equal(provisioned.cleanMachine, false);
  assert.equal(provisioned.console.exitCode, 0);
  assert.ok(provisioned.provisioned.some((p) => p.component === 'VC++ redistributable'));
  const runtime = await provisionSandbox(app, 'windows-app-runtime:1.8:x64');
  console.log('Windows App Runtime provisioned:', JSON.stringify(runtime.provisioned));
  assert.equal(runtime.provisioned[0].component, 'Windows App Runtime');
  const inventory = await sbx.exec({
    command: "Get-AppxPackage Microsoft.WindowsAppRuntime.1.8 | Select-Object Name,Version | ConvertTo-Json -Compress",
  });
  assert.equal(inventory.exitCode, 0);
  assert.match(inventory.stdout, /Microsoft.WindowsAppRuntime\.1\.8/);
  console.log('Observed registered runtime:', inventory.stdout);
  const status = await sbx.status();
  assert.equal(status.provisioning.cleanMachine, false);
  assert.ok(status.provisioning.provisioned.some((p) => p.component === 'Windows App Runtime'));
} finally {
  if (provisioned.kept) {
    const stopped = await sbx.stopSandbox({ target: provisioned.sandbox });
    assert.ok(!stopped.recordingError, stopped.recordingError);
    assert.deepEqual(await sbx.listSandboxes(), []);
  }
}
