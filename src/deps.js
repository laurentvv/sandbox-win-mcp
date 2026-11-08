// Host-only, conservative dependency inventory. This never executes an app or installs anything.
import fs from 'node:fs';
import path from 'node:path';

export const CLEAN_BASELINE = {
  description: 'Windows Sandbox baseline; actual optional components vary with the host Windows build',
  dotnetFramework: '4.8', powershell: '5.1',
  absent: ['Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App', 'Microsoft.AspNetCore.App', 'VC++ redistributable', 'Java', 'Python'],
};

// Record optional components against the actual guest build rather than guessing from the host.
export const GUEST_DEPENDENCY_INVENTORY = `$ErrorActionPreference='Stop'
$os=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$framework=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full'
$runtimes=@(foreach($base in @('C:\\Program Files\\dotnet\\shared','C:\\Program Files (x86)\\dotnet\\shared')) {
  if(Test-Path $base) { foreach($f in Get-ChildItem $base -Directory) {
    foreach($v in Get-ChildItem $f.FullName -Directory) { @{name=$f.Name;version=$v.Name;root=$base} }
  } }
})
$webview=@(foreach($key in @('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients','HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients','HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients')) {
  if(Test-Path $key) { Get-ChildItem $key | Get-ItemProperty | Where-Object { $_.name -like '*WebView2*' } | Select-Object name,pv }
})
$war=@(Get-AppxPackage -Name 'Microsoft.WindowsAppRuntime*' | Select-Object Name,Version,Architecture)
@{build="$($os.CurrentBuildNumber).$($os.UBR)";dotnetFrameworkRelease=$framework.Release;dotnetRuntimes=$runtimes;webview2=$webview;windowsAppRuntime=$war} | ConvertTo-Json -Depth 6 -Compress`;

/** Read ordinary and delay-load PE imports, with bounds checks on all untrusted offsets. */
export function readPe(b) {
  const check = (off, size) => {
    if (!Number.isSafeInteger(off) || off < 0 || off + size > b.length) throw new Error('Truncated or invalid PE image');
  };
  check(0, 64);
  if (b.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a PE image (missing MZ header)');
  const pe = b.readUInt32LE(60);
  check(pe, 24);
  if (b.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid PE signature');
  const machine = b.readUInt16LE(pe + 4), count = b.readUInt16LE(pe + 6), size = b.readUInt16LE(pe + 20);
  const opt = pe + 24;
  check(opt, size);
  check(opt, 2);
  const magic = b.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('Unsupported PE optional header');
  const dd = opt + (magic === 0x20b ? 112 : 96);
  if (dd > opt + size) throw new Error('Truncated PE optional header');
  check(opt + size, count * 40);
  const sections = Array.from({ length: count }, (_, i) => {
    const s = opt + size + i * 40;
    return { va: b.readUInt32LE(s + 12), length: b.readUInt32LE(s + 16), raw: b.readUInt32LE(s + 20) };
  });
  const offset = (rva, n = 1) => {
    const s = sections.find((s) => rva >= s.va && rva - s.va + n <= s.length);
    if (!s) throw new Error('PE RVA is outside file-backed sections');
    const p = s.raw + rva - s.va;
    check(p, n);
    return p;
  };
  const string = (rva) => {
    const p = offset(rva), end = b.indexOf(0, p);
    if (end < p || end - p > 4096) throw new Error('Invalid PE import name');
    offset(rva, end - p + 1);
    return b.toString('ascii', p, end);
  };
  const imports = [];
  for (const [index, stride, nameAt] of [[1, 20, 12], [13, 32, 4]]) {
    if (dd + index * 8 + 8 > opt + size) continue;
    const rva = b.readUInt32LE(dd + index * 8), bytes = b.readUInt32LE(dd + index * 8 + 4);
    if (!rva || !bytes) continue;
    for (let i = 0; i + stride <= bytes; i += stride) {
      const p = offset(rva + i, stride);
      if (b.subarray(p, p + stride).every((x) => x === 0)) break;
      // Old delay descriptors store VAs rather than RVAs. Do not silently misread them.
      if (index === 13 && !(b.readUInt32LE(p) & 1)) throw new Error('Legacy VA delay imports are not supported');
      imports.push(string(b.readUInt32LE(p + nameAt)).toLowerCase());
    }
  }
  return { machine: `0x${machine.toString(16)}`, architecture: ({ 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64' })[machine] || 'unknown',
    bits: magic === 0x20b ? 64 : 32, imports: [...new Set(imports)] };
}

export function scanDependencies(input) {
  const src = path.resolve(input), stat = fs.statSync(src), root = stat.isDirectory() ? src : path.dirname(src);
  if (stat.isFile() && /\.(msix|appx|msixbundle|appxbundle)$/i.test(src)) return {
    path: src, baseline: CLEAN_BASELINE, binaries: [], requirements: [{
      component: 'Packaged application dependencies', status: 'unknown', evidence: [path.basename(src)],
      remediation: 'Inspect the package AppxManifest and supply its dependency packages. This static scanner does not unpack signed packages or bundles.',
    }], warnings: [], limitations: ['Package contents were not inspected; sibling files are not treated as package requirements.'],
  };
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) files.push(p);
    }
  };
  walk(root);
  const binaries = [], requirements = [], warnings = [];
  const add = (r) => {
    const key = `${r.component}:${r.version || ''}:${r.architecture || ''}:${r.status}:${r.rollForward || ''}:${r.applyPatches}`;
    const existing = requirements.find((x) => x.key === key);
    if (existing) existing.evidence.push(r.evidence);
    else requirements.push({ key, ...r, evidence: [r.evidence] });
  };
  const requirement = (component, status, evidence, remediation, extra = {}) => add({ component, status, evidence, remediation, ...extra });
  for (const file of files) {
    const relative = path.relative(root, file);
    if (/\.(exe|dll)$/i.test(file)) {
      let pe;
      try { pe = readPe(fs.readFileSync(file)); }
      catch (e) { warnings.push(`${relative}: ${e.message}`); continue; }
      binaries.push({ file: relative, ...pe });
      for (const dll of pe.imports.filter((x) => /^(vcruntime140(?:_\d+)?|msvcp140(?:_\w+)?|concrt140)\.dll$/i.test(x))) {
        const local = files.some((p) => path.basename(p).toLowerCase() === dll &&
          [path.dirname(file), root].includes(path.dirname(p)));
        requirement('VC++ redistributable', local ? 'app-local' : 'missing', `${relative} imports ${dll}`,
          local ? 'Verify the app-local DLL and its transitive dependencies match the app architecture.' :
            `Install the latest official Microsoft Visual C++ v14 ${pe.architecture} redistributable (at least as recent as the app's build tools), or ship its permitted runtime DLLs app-local.`,
          { architecture: pe.architecture });
      }
      if (pe.imports.includes('microsoft.windowsappruntime.bootstrap.dll') || /Microsoft\.WindowsAppRuntime\.Bootstrap\.dll$/i.test(file)) {
        const local = files.some((p) => /^Microsoft\.WindowsAppRuntime\.dll$/i.test(path.basename(p)));
        requirement('Windows App Runtime', local ? 'app-local' : 'unknown', relative,
          'Use Windows App SDK self-contained deployment, or install the matching Windows App Runtime redistributable. The bootstrap DLL alone does not identify a runtime version.',
          { architecture: pe.architecture });
      }
    } else if (/\.runtimeconfig\.json$/i.test(file)) {
      let config;
      try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { throw new Error(`Invalid runtime configuration ${file}: ${e.message}`); }
      const rt = config.runtimeOptions || {};
      const apphost = binaries.find((b) => b.file.toLowerCase() === relative.replace(/\.runtimeconfig\.json$/i, '.exe').toLowerCase());
      const sibling = file.replace(/\.runtimeconfig\.json$/i, '.exe');
      let architecture = apphost?.architecture;
      if (!architecture && fs.existsSync(sibling)) {
        try { architecture = readPe(fs.readFileSync(sibling)).architecture; }
        catch (e) { warnings.push(`${path.basename(sibling)}: ${e.message}`); }
      }
      for (const framework of [rt.framework, ...(rt.frameworks || [])].filter(Boolean)) {
        requirement(framework.name, 'missing', relative,
          `Install ${framework.name} ${framework.version} (${architecture || 'app architecture'}); runtime rollForward=${rt.rollForward || 'Minor'}.`,
          { version: framework.version, architecture: architecture || 'unknown', rollForward: rt.rollForward || 'Minor', applyPatches: rt.applyPatches !== false });
      }
      for (const framework of rt.includedFrameworks || []) requirement(framework.name, 'app-local', relative,
        'Self-contained deployment: verify all publish output is present.', { version: framework.version, architecture: architecture || 'unknown' });
    } else if (/\.exe\.config$/i.test(file)) {
      const xml = fs.readFileSync(file, 'utf8');
      for (const match of xml.matchAll(/<supportedRuntime\b([^>]+)>?/gi)) {
        const version = /\bversion=["']([^"']+)/i.exec(match[1])?.[1];
        const sku = /\bsku=["']([^"']+)/i.exec(match[1])?.[1] || '';
        const target = /Version=v([\d.]+)/i.exec(sku)?.[1];
        const parts = target?.split('.').map(Number);
        const satisfied = version === 'v4.0' && (!parts || parts.every(Number.isFinite) &&
          (parts[0] < 4 || parts[0] === 4 && (parts[1] < 8 || parts[1] === 8 && parts.slice(2).every((n) => n === 0))));
        requirement('.NET Framework', satisfied ? 'satisfied' : 'unknown', relative,
          satisfied ? 'Windows Sandbox includes .NET Framework 4.8.' : `Enable/install the required .NET Framework (${version || sku}); .NET 3.5 is not assumed enabled.`,
          { version: target || version });
      }
    } else if (/AppxManifest\.xml$/i.test(file)) {
      const xml = fs.readFileSync(file, 'utf8');
      for (const m of xml.matchAll(/<(?:\w+:)?PackageDependency\b([^>]+)>?/gi)) {
        const name = /\bName=["']([^"']+)/i.exec(m[1])?.[1];
        const version = /\bMinVersion=["']([^"']+)/i.exec(m[1])?.[1];
        const identity = /<(?:\w+:)?Identity\b([^>]+)/i.exec(xml)?.[1] || '';
        const architecture = /\bProcessorArchitecture=["']([^"']+)/i.exec(identity)?.[1]?.toLowerCase() || 'unknown';
        if (name) requirement(name, 'unknown', relative, `Supply and register package dependency ${name} >= ${version || 'manifest minimum'} before installing this package.`, { version, architecture });
      }
    }
  }
  // File inputs only infer an interpreter for that entry point, not for incidental source files.
  const scriptFiles = stat.isDirectory() ? files.filter((p) => path.dirname(p) === root) : [src];
  for (const p of scriptFiles) {
    const ext = path.extname(p).toLowerCase(), evidence = path.relative(root, p);
    if (ext === '.jar') requirement('Java', 'missing', evidence, 'Install a JRE matching the application requirements, then use java -jar.');
    if (ext === '.py') requirement('Python', 'missing', evidence, 'Install the required Python version and application packages, or publish a self-contained executable.');
    if (['.ps1', '.bat', '.cmd'].includes(ext)) requirement(ext === '.ps1' ? 'Windows PowerShell' : 'cmd.exe', 'satisfied', evidence,
      ext === '.ps1' ? 'PowerShell 5.1 is inbox; PowerShell 7 modules and script-specific dependencies require separate verification.' : 'cmd.exe is inbox; commands invoked by the script require separate verification.');
  }
  return { path: src, baseline: CLEAN_BASELINE, binaries, requirements: requirements.map(({ key, ...r }) => r), warnings,
    limitations: ['Static scan only: plugins, dynamic loads, interpreter versions and installer prerequisites may require runtime observation.',
      'A shipped DLL is evidence, not proof of a complete or architecture-compatible self-contained deployment.',
      'Optional Windows App Runtime and WebView2 availability is unknown until checked in the actual guest.'] };
}

export function formatDependencies(scan) {
  return [
    'Dependency diagnosis (no dependencies installed):',
    ...scan.requirements.map((r) => `  [${r.status}] ${r.component}${r.version ? ` ${r.version}` : ''}${r.architecture ? ` (${r.architecture})` : ''}: ${r.remediation}`),
    ...scan.warnings.map((w) => `  warning: ${w}`),
    ...scan.limitations.map((w) => `  note: ${w}`),
  ].join('\n');
}

export function classifyDependencyFailure(result) {
  const text = [result.error, result.runtimeDiagnostic, result.console?.stdout, result.console?.stderr, ...(result.errors || []).map((e) => `${e.source}: ${e.message}`)].join('\n');
  const attempted = result.launchAttempted || result.launch || result.console || result.process;
  const failed = attempted && (result.error || result.process?.hasExited && result.process.exitCode !== 0 ||
    result.mode === 'gui' && !result.process?.hasWindow || result.crashes?.length) ||
    /You must install or update \.NET|hostfxr/i.test(text);
  if (!failed) return [];
  const findings = [];
  for (const r of result.dependencies?.requirements || []) {
    const installed = result.provisioned?.some((p) => p.architecture === r.architecture &&
      (p.component === r.component || r.component === 'Microsoft.NETCore.App' && p.component === 'Microsoft.WindowsDesktop.App' &&
        p.version?.split('.').slice(0, 2).join('.') === r.version?.split('.').slice(0, 2).join('.')));
    if (r.status !== 'missing' || installed) continue;
    findings.push({ component: r.component, version: r.version, confidence: 'likely',
      message: `Missing dependency: ${r.component}${r.version ? ` ${r.version}` : ''}. ${r.remediation}`, evidence: r.evidence });
  }
  if (!findings.length && /You must install or update \.NET|hostfxr|framework.*Microsoft\.(?:NETCore|WindowsDesktop|AspNetCore)\.App/i.test(text)) {
    const framework = /Framework:\s*['"]?(Microsoft\.(?:NETCore|WindowsDesktop|AspNetCore)\.App)['"]?,?\s*version:?\s*['"]?([\d.]+)/i.exec(text);
    findings.push({ component: framework?.[1] || '.NET runtime', version: framework?.[2], confidence: 'observed',
      message: `Missing dependency: ${framework ? `${framework[1]} ${framework[2]}` : '.NET runtime'}. Install the framework, version and architecture named in the hostfxr message.`, evidence: [text.slice(0, 4000)] });
  }
  if (!findings.length && /SideBySide|VCRUNTIME\d+|MSVCP\d+/i.test(text)) {
    findings.push({ component: 'Side-by-side runtime', confidence: 'possible', message: 'Possible missing dependency: inspect the SideBySide event for the exact assembly and install its matching redistributable.', evidence: [text.slice(0, 4000)] });
  }
  if (!findings.length && /FileNotFoundException|Could not load file or assembly/i.test(text) && /\.NET Runtime/i.test(text)) {
    findings.push({ component: '.NET assembly', confidence: 'possible',
      message: 'Possible missing dependency: .NET assembly. Publish the assembly named in the .NET Runtime event with the app, or install its documented prerequisite.', evidence: [text.slice(0, 4000)] });
  }
  return findings;
}
