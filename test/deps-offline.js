// Real Windows Sandbox proof. Supply a framework-dependent .NET desktop publish folder.
// This needs Windows Sandbox, host internet for the verified runtime download, and exclusive use of the guest.
import assert from 'node:assert/strict';
import { runApp, summary } from '../src/run.js';

const app = process.argv[2];
if (!app) throw new Error('Usage: node test\\deps-offline.js <framework-dependent .NET desktop app.exe|folder>');

const clean = await runApp({ app, network: 'off', waitSec: 2 });
console.log(summary(clean));
assert.equal(clean.pass, false, 'Framework-dependent app must not pass on a clean guest');
assert.equal(clean.cleanMachine, true);
assert.deepEqual(clean.provisioned, []);
assert.ok(clean.dependencyFindings.some((f) => f.component === 'Microsoft.WindowsDesktop.App'));
assert.ok(clean.guestBaseline.build);

const provisioned = await runApp({ app, network: 'off', waitSec: 2, provision: 'auto' });
console.log(summary(provisioned));
assert.equal(provisioned.pass, true, 'Explicit desktop runtime provisioning must make the app run');
assert.equal(provisioned.cleanMachine, false);
assert.equal(provisioned.process.hasWindow, true);
assert.ok(provisioned.provisioned.some((p) => p.component === 'Microsoft.WindowsDesktop.App'));
assert.ok(provisioned.provisioned.every((p) => p.verification.signer.includes('Microsoft Corporation')));
assert.deepEqual(provisioned.dependencyFindings, []);
