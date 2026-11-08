// System change snapshots for the sbx guest agent: what did an installer (or anything else) change?
// Take() records files, registry keys, services, autoruns/environment values and installed programs into a
// tab-separated file; Diff() compares two of them. C# 5 so Windows PowerShell 5.1's Add-Type can compile it.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Microsoft.Win32;

public static class SbxSnap {
    // Paths that change on an idle machine, or are ours. %VARS% expanded at runtime. A trailing * means a plain
    // prefix match; otherwise the path itself and everything below it.
    static readonly string[] DefaultExcludes = {
        @"C:\sbx", @"C:\apps", @"C:\sbx-test", @"C:\sbx-snap", @"%LOCALAPPDATA%\Temp\sbx-uia", @"%LOCALAPPDATA%\Temp\StructuredQuery.log",
        @"%USERPROFILE%\ntuser.dat*", @"%LOCALAPPDATA%\Microsoft\Windows\UsrClass.dat*",
        @"%LOCALAPPDATA%\Packages\MicrosoftWindows.*", @"%LOCALAPPDATA%\Packages\Microsoft.*",
        @"%LOCALAPPDATA%\Microsoft\Windows\Caches", @"%LOCALAPPDATA%\Microsoft\Windows\Explorer", @"%LOCALAPPDATA%\Microsoft\Windows\WebCache",
        @"%LOCALAPPDATA%\Microsoft\Windows\INetCache", @"%LOCALAPPDATA%\Microsoft\Windows\INetCookies", @"%LOCALAPPDATA%\Microsoft\Windows\Notifications",
        @"%LOCALAPPDATA%\Microsoft\Windows\PowerShell", @"%LOCALAPPDATA%\Microsoft\Internet Explorer\CacheStorage",
        @"%LOCALAPPDATA%\Comms", @"%LOCALAPPDATA%\ConnectedDevicesPlatform", @"%LOCALAPPDATA%\Microsoft\Windows\ActionCenterCache",
        @"%USERPROFILE%\AppData\LocalLow\Microsoft\CryptnetUrlCache", @"%APPDATA%\Microsoft\Windows\Themes", @"%APPDATA%\Microsoft\Windows\Recent",
        @"C:\ProgramData\Microsoft\Windows\ClipSVC", @"C:\ProgramData\Microsoft\Network\Downloader", @"C:\ProgramData\Microsoft\Windows\DeviceMetadataCache",
        @"C:\ProgramData\Microsoft\Windows Defender", @"C:\ProgramData\Microsoft\Diagnosis", @"C:\ProgramData\Microsoft\Search",
        @"C:\ProgramData\Microsoft\Windows\WER", @"C:\ProgramData\Microsoft\Windows\AppRepository", @"C:\ProgramData\USOShared", @"C:\ProgramData\USOPrivate",
        @"C:\ProgramData\Microsoft\Windows\wfp", @"C:\ProgramData\Microsoft\Crypto\RSA\MachineKeys",
        @"C:\Windows\System32\Tasks\Microsoft", @"C:\Windows\System32\perf*",
    };
    static readonly string[] DefaultRegExcludes = {
        @"HKCU\Software\Classes\Local Settings", @"HKLM\SOFTWARE\Classes\Local Settings",
        @"HKCU\Software\Microsoft\Windows\CurrentVersion\CloudExperienceHost", @"HKCU\Software\Microsoft\Windows\CurrentVersion\IrisService",
        @"HKCU\Software\Microsoft\Windows\CurrentVersion\RulesEngine", @"HKCU\Software\Microsoft\Windows\CurrentVersion\CloudStore",
        @"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Discardable", @"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops",
        @"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\SessionInfo", @"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FeatureUsage",
        @"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist", @"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\RecentDocs",
        @"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32", @"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Streams",
        @"HKCU\Software\Microsoft\Windows\Shell\BagMRU", @"HKCU\Software\Microsoft\Windows\Shell\Bags",
        @"HKLM\SOFTWARE\Microsoft\Wbem", @"HKLM\SOFTWARE\Microsoft\Security Center", @"HKLM\SOFTWARE\Microsoft\Windows Defender",
        @"HKLM\SOFTWARE\Microsoft\SystemCertificates\AuthRoot", @"HKLM\SOFTWARE\WOW6432Node\Microsoft\SystemCertificates\AuthRoot",
        @"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule", @"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\AppCompatFlags",
        @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Appx", @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\whesvc",
        @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate", @"HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting",
        @"HKLM\SOFTWARE\Policies\Microsoft\Windows\BITS", @"HKLM\SOFTWARE\WOW6432Node\Policies\Microsoft\Windows\BITS",
        @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Diagnostics", @"HKLM\SOFTWARE\Microsoft\SQMClient", @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing",
        // Windows bookkeeping any installer triggers (the product itself still shows up under installed programs).
        @"HKCU\Software\Microsoft\RestartManager", @"HKLM\SOFTWARE\Microsoft\RestartManager", @"HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags",
        @"HKCU\Software\Microsoft\Windows\CurrentVersion\Security and Maintenance", @"HKCU\Software\Microsoft\Windows\CurrentVersion\Start",
        @"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts", @"HKLM\SOFTWARE\Microsoft\RemovalTools", @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\UFH",
        @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Installer", @"HKLM\SOFTWARE\Classes\Installer",
    };
    static readonly HashSet<string> ServiceNoise = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "BITS", "wuauserv", "UsoSvc", "WaaSMedicSvc", "sppsvc", "TrustedInstaller", "edgeupdate", "edgeupdatem", "MapsBroker",
    };

    static readonly HashSet<string> RunnableExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        ".exe", ".dll", ".sys", ".scr", ".com", ".cpl", ".msi", ".ps1", ".psm1", ".bat", ".cmd", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".hta", ".lnk", ".jar",
    };

    static string[] FlatRoots = { @"C:\", @"C:\Windows", @"C:\Windows\System32", @"C:\Windows\SysWOW64" };
    static string[] DeepRoots = {
        @"C:\Program Files", @"C:\Program Files (x86)", @"C:\ProgramData", @"C:\Users",
        @"C:\Windows\System32\Tasks", @"C:\Windows\System32\drivers",
    };
    static readonly HashSet<string> KnownTopDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "Windows", "Program Files", "Program Files (x86)", "ProgramData", "Users", "$Recycle.Bin", "System Volume Information",
        "Recovery", "PerfLogs", "Documents and Settings", "Config.Msi",
    };
    static string[] RegRoots = { @"HKLM\SOFTWARE", @"HKCU\Software" };
    static string[] ValueKeys = {
        @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce",
        @"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run", @"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce",
        @"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", @"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce",
        @"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment", @"HKCU\Environment",
        @"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon",
        @"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options",
    };
    public static string[] UninstallRoots = {
        @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", @"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        @"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    };
    static string[] UninstallValues = { "DisplayName", "DisplayVersion", "Publisher", "InstallLocation", "UninstallString", "QuietUninstallString", "WindowsInstaller", "SystemComponent" };

    static List<string> Prefixes(IEnumerable<string> list) {
        return list.Select(p => Environment.ExpandEnvironmentVariables(p).TrimEnd('\\')).ToList();
    }
    static bool Excluded(string path, List<string> ex) {
        foreach (var e in ex) {
            if (e.EndsWith("*")) { if (path.StartsWith(e.Substring(0, e.Length - 1), StringComparison.OrdinalIgnoreCase)) return true; }
            else if (path.StartsWith(e, StringComparison.OrdinalIgnoreCase) && (path.Length == e.Length || path[e.Length] == '\\')) return true;
        }
        return false;
    }
    static string Clean(string s) { return s == null ? "" : s.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' '); }

    public static Hashtable Take(string file, string[] extraExcludes) {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var ex = Prefixes(DefaultExcludes.Concat(extraExcludes ?? new string[0]));
        var lines = new List<string>(200000);
        int files = 0, dirs = 0, keys = 0;
        foreach (var r in FlatRoots) Walk(r, false, ex, lines, ref files, ref dirs);
        var deep = new List<string>(DeepRoots);
        try {
            foreach (var d in new DirectoryInfo(@"C:\").GetDirectories())
                if (!KnownTopDirs.Contains(d.Name) && (d.Attributes & FileAttributes.ReparsePoint) == 0) deep.Add(d.FullName);
        } catch { }
        foreach (var r in deep) Walk(r, true, ex, lines, ref files, ref dirs);

        var rex = Prefixes(DefaultRegExcludes.Concat((extraExcludes ?? new string[0]).Where(e => e.StartsWith("HK", StringComparison.OrdinalIgnoreCase))));
        foreach (var r in RegRoots) WalkKeys(r, rex, lines, ref keys);
        foreach (var k in ValueKeys) Values(k, null, lines);
        foreach (var root in UninstallRoots) {
            using (var key = Open(root)) {
                if (key == null) continue;
                foreach (var sub in key.GetSubKeyNames()) Values(root + "\\" + sub, UninstallValues, lines);
            }
        }
        int services = Services(lines);
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        File.WriteAllLines(file, lines, new UTF8Encoding(false));
        var h = new Hashtable();
        h["path"] = file; h["files"] = files; h["dirs"] = dirs; h["registryKeys"] = keys; h["services"] = services;
        h["ms"] = sw.ElapsedMilliseconds;
        return h;
    }

    static readonly string TempDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"\Temp";
    // Compilers and installers litter %TEMP% with empty random dirs; they aren't interesting leftovers.
    static bool IsEmptyTempDir(string full) {
        if (!string.Equals(Parent(full), TempDir, StringComparison.OrdinalIgnoreCase)) return false;
        try { return !Directory.EnumerateFileSystemEntries(full).Any(); } catch { return false; }
    }

    static void Walk(string root, bool deep, List<string> ex, List<string> lines, ref int files, ref int dirs) {
        var stack = new Stack<DirectoryInfo>();
        var rootInfo = new DirectoryInfo(root);
        if (!rootInfo.Exists) return;
        stack.Push(rootInfo);
        while (stack.Count > 0) {
            var d = stack.Pop();
            FileSystemInfo[] items;
            try { items = d.GetFileSystemInfos(); } catch { continue; }
            foreach (var i in items) {
                var full = i.FullName;
                if (Excluded(full, ex)) continue;
                if ((i.Attributes & FileAttributes.Directory) != 0) {
                    if (!deep) continue;
                    if ((i.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                    if (IsEmptyTempDir(full)) continue;
                    lines.Add("d\t" + full + "\t"); dirs++;
                    stack.Push((DirectoryInfo)i);
                } else {
                    long len = 0; try { len = ((FileInfo)i).Length; } catch { }
                    lines.Add("f\t" + full + "\t" + len + "|" + i.LastWriteTimeUtc.Ticks); files++;
                }
            }
        }
    }

    static RegistryKey Open(string path) {
        int slash = path.IndexOf('\\');
        var hive = slash < 0 ? path : path.Substring(0, slash);
        var rest = slash < 0 ? "" : path.Substring(slash + 1);
        RegistryKey baseKey = hive == "HKLM" ? Registry.LocalMachine : hive == "HKCU" ? Registry.CurrentUser : null;
        if (baseKey == null) return null;
        try { return rest == "" ? baseKey : baseKey.OpenSubKey(rest, false); } catch { return null; }
    }

    static void WalkKeys(string root, List<string> ex, List<string> lines, ref int keys) {
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0) {
            var path = stack.Pop();
            using (var k = Open(path)) {
                if (k == null) continue;
                string[] subs;
                try { subs = k.GetSubKeyNames(); } catch { continue; }
                foreach (var s in subs) {
                    var child = path + "\\" + s;
                    if (Excluded(child, ex)) continue;
                    lines.Add("k\t" + Clean(child) + "\t"); keys++;
                    stack.Push(child);
                }
            }
        }
    }

    static void Values(string keyPath, string[] only, List<string> lines) {
        using (var k = Open(keyPath)) {
            if (k == null) return;
            foreach (var n in only ?? k.GetValueNames()) {
                object v; try { v = k.GetValue(n, null, RegistryValueOptions.DoNotExpandEnvironmentNames); } catch { continue; }
                if (v == null) continue;
                var s = v is string[] ? string.Join(";", (string[])v) : v is byte[] ? BitConverter.ToString((byte[])v).Replace("-", "") : Convert.ToString(v);
                lines.Add("v\t" + Clean(keyPath + "\\" + (n == "" ? "(default)" : n)) + "\t" + Clean(s));
            }
        }
    }

    static int Services(List<string> lines) {
        int n = 0;
        using (var k = Open(@"HKLM\SYSTEM\CurrentControlSet\Services")) {
            if (k == null) return 0;
            foreach (var name in k.GetSubKeyNames()) {
                using (var s = k.OpenSubKey(name)) {
                    if (s == null || s.GetValue("Type") == null || ServiceNoise.Contains(name)) continue;
                    var type = Convert.ToInt32(s.GetValue("Type"));
                    lines.Add("s\t" + Clean(name) + "\t" + Clean(Convert.ToString(s.GetValue("DisplayName"))) + "|" + ((type & 3) != 0 ? "driver" : "service") +
                        "|" + Convert.ToString(s.GetValue("Start")) + "|" + Clean(Convert.ToString(s.GetValue("ImagePath", "", RegistryValueOptions.DoNotExpandEnvironmentNames))));
                    n++;
                }
            }
        }
        return n;
    }

    static Dictionary<string, string> Load(string file) {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in File.ReadLines(file)) {
            int a = line.IndexOf('\t'), b = line.IndexOf('\t', a + 1);
            if (a < 0 || b < 0) continue;
            d[line.Substring(0, b)] = line.Substring(b + 1);
        }
        return d;
    }

    static string Parent(string p) { int i = p.LastIndexOf('\\'); return i <= 0 ? null : p.Substring(0, i); }

    // Topmost new containers instead of every file/key below them.
    static ArrayList Collapse(List<string> paths, HashSet<string> newContainers, Func<string, long> size, int max, out int total) {
        var groups = new Dictionary<string, long[]>(StringComparer.OrdinalIgnoreCase);
        var order = new List<string>();
        foreach (var p in paths) {
            string top = null;
            for (var c = Parent(p); c != null && newContainers.Contains(c); c = Parent(c)) top = c;
            if (top == null && newContainers.Contains(p)) top = p;
            var key = top ?? p;
            long[] g;
            if (!groups.TryGetValue(key, out g)) { g = new long[] { 0, 0, top == null ? 0 : 1 }; groups[key] = g; order.Add(key); }
            if (p != key || top == null) { g[0]++; g[1] += size(p); }
        }
        var list = new ArrayList();
        total = order.Count;
        foreach (var k in order.OrderBy(x => x, StringComparer.OrdinalIgnoreCase)) {
            if (list.Count >= max) break;
            var g = groups[k];
            var h = new Hashtable();
            h["path"] = k;
            if (g[2] == 1) { h["container"] = true; h["items"] = g[0]; }
            if (g[1] > 0) h["bytes"] = g[1];
            list.Add(h);
        }
        return list;
    }

    static Hashtable Section(Dictionary<string, string> a, Dictionary<string, string> b, string itemKind, string containerKind, int max) {
        var added = new List<string>(); var removed = new List<string>(); var changed = new List<string>();
        var newC = new HashSet<string>(StringComparer.OrdinalIgnoreCase); var goneC = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in b) {
            var kind = kv.Key.Substring(0, kv.Key.IndexOf('\t')); var path = kv.Key.Substring(kind.Length + 1);
            string old;
            if (kind == itemKind) { if (!a.TryGetValue(kv.Key, out old)) added.Add(path); else if (old != kv.Value) changed.Add(path); }
            else if (kind == containerKind && !a.ContainsKey(kv.Key)) { newC.Add(path); added.Add(path); }
        }
        foreach (var kv in a) {
            var kind = kv.Key.Substring(0, kv.Key.IndexOf('\t')); var path = kv.Key.Substring(kind.Length + 1);
            if ((kind == itemKind || kind == containerKind) && !b.ContainsKey(kv.Key)) { removed.Add(path); if (kind == containerKind) goneC.Add(path); }
        }
        Func<Dictionary<string, string>, Func<string, long>> sizeOf = d => p => {
            string v; if (!d.TryGetValue(itemKind + "\t" + p, out v)) return 0;
            long n; return long.TryParse(v.Split('|')[0], out n) ? n : 0;
        };
        var h = new Hashtable();
        int t;
        h["added"] = Collapse(added, newC, sizeOf(b), max, out t); h["addedGroups"] = t;
        h["removed"] = Collapse(removed, goneC, sizeOf(a), max, out t); h["removedGroups"] = t;
        h["changed"] = changed.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).Take(max).ToList(); h["changedCount"] = changed.Count;
        h["addedCount"] = added.Count; h["removedCount"] = removed.Count;
        if (itemKind == "f") {
            h["addedBytes"] = added.Sum(p => sizeOf(b)(p));
            // Runnable files that appeared anywhere, including inside new folders that the list above collapses.
            var exe = added.Where(p => !newC.Contains(p) && RunnableExt.Contains(System.IO.Path.GetExtension(p))).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
            h["executables"] = exe.Take(max).ToList(); h["executableCount"] = exe.Count;
        }
        return h;
    }

    static ArrayList Pairs(Dictionary<string, string> a, Dictionary<string, string> b, string kind, Func<string, bool> filter, int max) {
        var list = new ArrayList();
        var keys = a.Keys.Concat(b.Keys).Where(k => k.StartsWith(kind + "\t")).Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(k => k, StringComparer.OrdinalIgnoreCase);
        foreach (var k in keys) {
            var path = k.Substring(kind.Length + 1);
            if (filter != null && !filter(path)) continue;
            string x, y; bool inA = a.TryGetValue(k, out x), inB = b.TryGetValue(k, out y);
            if (inA && inB && x == y) continue;
            if (list.Count >= max) break;
            var h = new Hashtable();
            h["name"] = path; h["change"] = !inA ? "added" : !inB ? "removed" : "changed";
            if (inA) h["before"] = x;
            if (inB) h["after"] = y;
            list.Add(h);
        }
        return list;
    }

    static bool IsUninstall(string path) {
        foreach (var r in UninstallRoots) if (path.StartsWith(r + "\\", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    // Installed-programs entries (Add/Remove Programs) present in one snapshot and not the other.
    static ArrayList Programs(Dictionary<string, string> from, Dictionary<string, string> to) {
        Func<Dictionary<string, string>, Dictionary<string, Hashtable>> group = d => {
            var g = new Dictionary<string, Hashtable>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in d) {
                if (!kv.Key.StartsWith("v\t")) continue;
                var p = kv.Key.Substring(2);
                if (!IsUninstall(p)) continue;
                var key = Parent(p); var name = p.Substring(key.Length + 1);
                Hashtable h; if (!g.TryGetValue(key, out h)) { h = new Hashtable(); h["key"] = key; g[key] = h; }
                h[char.ToLowerInvariant(name[0]) + name.Substring(1)] = kv.Value;
            }
            return g;
        };
        var ga = group(from); var gb = group(to);
        var list = new ArrayList();
        foreach (var kv in gb) if (!ga.ContainsKey(kv.Key) && kv.Value.ContainsKey("displayName")) list.Add(kv.Value);
        return list;
    }

    public static Hashtable Diff(string fileA, string fileB, int max) {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var a = Load(fileA); var b = Load(fileB);
        var h = new Hashtable();
        h["files"] = Section(a, b, "f", "d", max);
        h["registry"] = Section(a, b, "x", "k", max);
        h["values"] = Pairs(a, b, "v", p => !IsUninstall(p), max);
        h["services"] = Pairs(a, b, "s", null, max);
        h["programsAdded"] = Programs(a, b);
        h["programsRemoved"] = Programs(b, a);
        h["ms"] = sw.ElapsedMilliseconds;
        return h;
    }
}
