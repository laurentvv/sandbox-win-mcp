// UI Automation helper for the sbx guest agent (compiled in the sandbox by agent.ps1 with Add-Type).
// Uses the native UIA COM API, the one Inspect.exe uses, whose built-in proxies understand Win32, WinForms, WPF,
// UWP/WinUI and browsers. (The managed System.Windows.Automation client sees WinForms controls as bare panes.)
// The COM interop assembly is generated at runtime from UIAutomationCore.dll's type library, so nothing binary ships.
// Written for the C# 5 compiler that Windows PowerShell 5.1 uses.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using UIAutomationClient;

public static class SbxUia
{
    const int ProcessIdProp = 30002, ControlTypeProp = 30003, AutomationIdProp = 30011;
    const int InvokeId = 10000, ValueId = 10002, ExpandCollapseId = 10005, SelectionItemId = 10010, ToggleId = 10015, LegacyId = 10018;

    static IUIAutomation a;
    static IUIAutomation A { get { if (a == null) a = new CUIAutomation8(); return a; } }

    static readonly string[] TypeNames = {
        "Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List", "Menu",
        "MenuBar", "MenuItem", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner", "StatusBar", "Tab", "TabItem",
        "Text", "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group", "Thumb", "DataGrid", "DataItem",
        "Document", "SplitButton", "Window", "Pane", "Header", "HeaderItem", "Table", "TitleBar", "Separator", "SemanticZoom", "AppBar" };

    static string TypeName(int id) { int i = id - 50000; return i >= 0 && i < TypeNames.Length ? TypeNames[i] : id.ToString(); }
    static int TypeId(string name)
    {
        string n = name.Replace(" ", "");
        for (int i = 0; i < TypeNames.Length; i++)
            if (string.Equals(TypeNames[i], n, StringComparison.OrdinalIgnoreCase)) return 50000 + i;
        throw new ArgumentException("Unknown control type '" + name + "'. Use one of: " + string.Join(", ", TypeNames));
    }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc f, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
    [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

    static T Safe<T>(Func<T> f) { try { return f(); } catch { return default(T); } }
    static T Pattern<T>(IUIAutomationElement e, int id) where T : class { try { return e.GetCurrentPattern(id) as T; } catch { return null; } }
    static IEnumerable<IUIAutomationElement> Items(IUIAutomationElementArray arr)
    {
        if (arr == null) yield break;
        for (int i = 0; i < arr.Length; i++) yield return arr.GetElement(i);
    }

    // UIA calls go to the target app and can block (an Invoke that opens a modal dialog returns only when it closes),
    // so every operation runs on an MTA worker thread with a timeout and the agent never hangs.
    static T Run<T>(Func<T> f, int timeoutMs, Func<T> onTimeout)
    {
        T result = default(T); Exception error = null;
        var th = new Thread(() => { try { result = f(); } catch (Exception ex) { error = ex; } });
        th.IsBackground = true; th.SetApartmentState(ApartmentState.MTA); th.Start();
        if (!th.Join(timeoutMs)) return onTimeout();
        if (error != null) throw new InvalidOperationException(error.Message);
        return result;
    }

    // Top-level windows to search: those of a process and/or whose title contains text; default the foreground window.
    static List<IUIAutomationElement> Roots(int pid, string title)
    {
        if (pid <= 0 && string.IsNullOrEmpty(title))
        {
            IntPtr h = GetForegroundWindow();
            if (h == IntPtr.Zero) throw new InvalidOperationException("No foreground window; pass windowTitle or pid.");
            return new List<IUIAutomationElement> { A.ElementFromHandle(h) };
        }
        IUIAutomationCondition c = pid > 0 ? A.CreatePropertyCondition(ProcessIdProp, pid) : A.CreateTrueCondition();
        var roots = Items(A.GetRootElement().FindAll(TreeScope.TreeScope_Children, c)).ToList();
        if (roots.Count == 0 && pid > 0)
        {
            // UIA can attribute a process's window to another one (a console app's MessageBox, for one); ask Win32.
            var handles = new List<IntPtr>();
            EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) handles.Add(h); return true; }, IntPtr.Zero);
            foreach (var h in handles) { var e = Safe(() => A.ElementFromHandle(h)); if (e != null) roots.Add(e); }
        }
        return roots
            .Where(e => string.IsNullOrEmpty(title) || (Safe(() => e.CurrentName) ?? "").IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0)
            .ToList();
    }

    static List<IUIAutomationElement> Matches(int pid, string title, string name, string automationId, string controlType)
    {
        IUIAutomationCondition c = A.CreateTrueCondition();
        if (!string.IsNullOrEmpty(automationId)) c = A.CreatePropertyCondition(AutomationIdProp, automationId);
        if (!string.IsNullOrEmpty(controlType))
        {
            IUIAutomationCondition t = A.CreatePropertyCondition(ControlTypeProp, TypeId(controlType));
            c = string.IsNullOrEmpty(automationId) ? t : A.CreateAndCondition(c, t);
        }
        var found = new List<IUIAutomationElement>();
        foreach (var r in Roots(pid, title)) found.AddRange(Items(r.FindAll(TreeScope.TreeScope_Subtree, c)));
        if (!string.IsNullOrEmpty(name))
        {
            var exact = found.Where(e => string.Equals(Safe(() => e.CurrentName), name, StringComparison.OrdinalIgnoreCase)).ToList();
            found = exact.Count > 0 ? exact
                : found.Where(e => (Safe(() => e.CurrentName) ?? "").IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
        }
        return found;
    }

    static Dictionary<string, object> Describe(IUIAutomationElement e, int depth)
    {
        var d = new Dictionary<string, object>();
        if (depth >= 0) d["depth"] = depth;
        d["type"] = TypeName(Safe(() => e.CurrentControlType));
        d["name"] = Safe(() => e.CurrentName) ?? "";
        string id = Safe(() => e.CurrentAutomationId);
        if (!string.IsNullOrEmpty(id)) d["automationId"] = id;
        if (Safe(() => e.CurrentIsEnabled) == 0) d["enabled"] = false;
        tagRECT r = Safe(() => e.CurrentBoundingRectangle);
        d["rect"] = new[] { r.left, r.top, r.right - r.left, r.bottom - r.top };
        var actions = new List<string>();
        if (Pattern<IUIAutomationInvokePattern>(e, InvokeId) != null) actions.Add("invoke");
        var v = Pattern<IUIAutomationValuePattern>(e, ValueId);
        if (v != null)
        {
            if (Safe(() => e.CurrentIsPassword) == 0) d["value"] = Safe(() => v.CurrentValue) ?? "";
            if (Safe(() => v.CurrentIsReadOnly) == 0) actions.Add("setvalue");
        }
        var t = Pattern<IUIAutomationTogglePattern>(e, ToggleId);
        if (t != null) { actions.Add("toggle"); d["toggled"] = Safe(() => t.CurrentToggleState) == ToggleState.ToggleState_On; }
        var s = Pattern<IUIAutomationSelectionItemPattern>(e, SelectionItemId);
        if (s != null) { actions.Add("select"); d["selected"] = Safe(() => s.CurrentIsSelected) != 0; }
        var x = Pattern<IUIAutomationExpandCollapsePattern>(e, ExpandCollapseId);
        if (x != null) { actions.Add("expand"); actions.Add("collapse"); }
        if (actions.Count > 0) d["actions"] = actions;
        return d;
    }

    public static Dictionary<string, object> Tree(int pid, string title, int maxDepth, int maxNodes, int timeoutMs)
    {
        return Run(() =>
        {
            var nodes = new List<Dictionary<string, object>>();
            var roots = Roots(pid, title);
            if (roots.Count == 0) throw new InvalidOperationException("No window found (title='" + title + "' pid=" + pid + ")");
            var w = A.ControlViewWalker;
            foreach (var r in roots) Walk(w, r, 0, maxDepth, maxNodes, nodes);
            return new Dictionary<string, object> { { "nodes", nodes }, { "truncated", nodes.Count >= maxNodes } };
        }, timeoutMs, () => { throw new TimeoutException("UI tree took longer than " + timeoutMs + "ms (app not responding?)"); });
    }

    static void Walk(IUIAutomationTreeWalker w, IUIAutomationElement e, int depth, int maxDepth, int maxNodes, List<Dictionary<string, object>> nodes)
    {
        if (nodes.Count >= maxNodes) return;
        nodes.Add(Describe(e, depth));
        if (depth >= maxDepth) return;
        IUIAutomationElement c = Safe(() => w.GetFirstChildElement(e));
        while (c != null && nodes.Count < maxNodes)
        {
            Walk(w, c, depth + 1, maxDepth, maxNodes, nodes);
            IUIAutomationElement cur = c;
            c = Safe(() => w.GetNextSiblingElement(cur));
        }
    }

    public static Dictionary<string, object> Act(int pid, string title, string name, string automationId, string controlType,
        int index, string action, string value, int timeoutMs)
    {
        action = (action ?? "click").ToLowerInvariant();
        return Run(() =>
        {
            var m = Matches(pid, title, name, automationId, controlType);
            if (m.Count == 0) throw new InvalidOperationException("No element matches " + Selector(name, automationId, controlType) + ". Use uitree to see what is there.");
            if (index >= m.Count) throw new InvalidOperationException(m.Count + " element(s) match " + Selector(name, automationId, controlType) + "; index " + index + " is out of range.");
            var e = m[index];
            var info = Describe(e, -1);
            info["matches"] = m.Count;
            info["did"] = Do(e, action, value);
            if (action == "setvalue" || action == "read") { var v = Pattern<IUIAutomationValuePattern>(e, ValueId); if (v != null) info["value"] = Safe(() => v.CurrentValue); }
            return info;
        }, timeoutMs, () => new Dictionary<string, object> {
            { "did", action }, { "pending", true },
            { "note", "Still running after " + timeoutMs + "ms; the app is probably showing a modal dialog. Use uitree or a screenshot to see it." } });
    }

    static string Selector(string name, string automationId, string controlType)
    {
        var p = new List<string>();
        if (!string.IsNullOrEmpty(name)) p.Add("name '" + name + "'");
        if (!string.IsNullOrEmpty(automationId)) p.Add("automationId '" + automationId + "'");
        if (!string.IsNullOrEmpty(controlType)) p.Add("type " + controlType);
        return p.Count > 0 ? string.Join(", ", p) : "(anything)";
    }

    static string Do(IUIAutomationElement e, string action, string value)
    {
        switch (action)
        {
            case "click":
            case "invoke":
                var inv = Pattern<IUIAutomationInvokePattern>(e, InvokeId); if (inv != null) { inv.Invoke(); return "invoke"; }
                var tg = Pattern<IUIAutomationTogglePattern>(e, ToggleId); if (tg != null) { tg.Toggle(); return "toggle"; }
                var si = Pattern<IUIAutomationSelectionItemPattern>(e, SelectionItemId); if (si != null) { si.Select(); return "select"; }
                var ec = Pattern<IUIAutomationExpandCollapsePattern>(e, ExpandCollapseId);
                if (ec != null)
                {
                    if (ec.CurrentExpandCollapseState == ExpandCollapseState.ExpandCollapseState_Collapsed) { ec.Expand(); return "expand"; }
                    ec.Collapse(); return "collapse";
                }
                var la = Pattern<IUIAutomationLegacyIAccessiblePattern>(e, LegacyId);
                if (la != null && !string.IsNullOrEmpty(Safe(() => la.CurrentDefaultAction))) { la.DoDefaultAction(); return "default action"; }
                Mouse(e, false, false); return "mouse click";
            case "doubleclick": Mouse(e, false, true); return "mouse double-click";
            case "rightclick": Mouse(e, true, false); return "mouse right-click";
            case "setvalue":
            case "set":
                var v = Pattern<IUIAutomationValuePattern>(e, ValueId);
                if (v != null && Safe(() => v.CurrentIsReadOnly) == 0) { v.SetValue(value ?? ""); return "setvalue"; }
                var lv = Pattern<IUIAutomationLegacyIAccessiblePattern>(e, LegacyId);
                if (lv != null) { lv.SetValue(value ?? ""); return "setvalue (legacy)"; }
                throw new InvalidOperationException("This element does not take a value. Click it and use type instead.");
            case "toggle": Need<IUIAutomationTogglePattern>(e, ToggleId, "toggle").Toggle(); return "toggle";
            case "select": Need<IUIAutomationSelectionItemPattern>(e, SelectionItemId, "select").Select(); return "select";
            case "expand": Need<IUIAutomationExpandCollapsePattern>(e, ExpandCollapseId, "expand").Expand(); return "expand";
            case "collapse": Need<IUIAutomationExpandCollapsePattern>(e, ExpandCollapseId, "collapse").Collapse(); return "collapse";
            case "focus": e.SetFocus(); return "focus";
            case "read": return "read";
            default: throw new ArgumentException("Unknown action '" + action + "'. Use click, doubleclick, rightclick, setvalue, toggle, select, expand, collapse, focus or read.");
        }
    }

    static T Need<T>(IUIAutomationElement e, int id, string action) where T : class
    {
        T p = Pattern<T>(e, id);
        if (p == null) throw new InvalidOperationException("This element can't " + action + ".");
        return p;
    }

    static void Mouse(IUIAutomationElement e, bool right, bool dbl)
    {
        int x, y;
        tagPOINT p;
        if (e.GetClickablePoint(out p) != 0) { x = p.x; y = p.y; }
        else { tagRECT r = e.CurrentBoundingRectangle; x = (r.left + r.right) / 2; y = (r.top + r.bottom) / 2; }
        try { e.SetFocus(); } catch { }
        SetCursorPos(x, y); Thread.Sleep(50);
        uint down = right ? 0x08u : 0x02u, up = right ? 0x10u : 0x04u;
        for (int i = 0; i < (dbl ? 2 : 1); i++) { mouse_event(down, 0, 0, 0, IntPtr.Zero); mouse_event(up, 0, 0, 0, IntPtr.Zero); Thread.Sleep(60); }
    }

    // ---------- smart input (UIA-first ladder, M2) ----------

    /** True when the element exposes at least one pattern we can drive (the actionable ones). */
    static bool HasControlPattern(IUIAutomationElement e)
    {
        return Pattern<IUIAutomationInvokePattern>(e, InvokeId) != null
            || Pattern<IUIAutomationTogglePattern>(e, ToggleId) != null
            || Pattern<IUIAutomationSelectionItemPattern>(e, SelectionItemId) != null
            || Pattern<IUIAutomationExpandCollapsePattern>(e, ExpandCollapseId) != null
            || Pattern<IUIAutomationValuePattern>(e, ValueId) != null;
    }

    /** Observable state of an element, for before/after effect checks. */
    static string Fingerprint(Dictionary<string, object> d)
    {
        var parts = new List<string>();
        foreach (string k in new[] { "name", "value", "toggled", "selected" })
            if (d.ContainsKey(k)) parts.Add(k + "=" + Convert.ToString(d[k]));
        return string.Join(";", parts.ToArray());
    }

    /** HWND of the top-level window that contains the element (0 when UIA cannot tell). */
    static IntPtr TopHandle(IUIAutomationElement e)
    {
        var w = A.ControlViewWalker;
        var cur = e;
        while (true)
        {
            var parent = Safe(() => w.GetParentElement(cur));
            if (parent == null) break;
            cur = parent;
        }
        // CurrentNativeWindowHandle is IntPtr in the generated interop; Safe defaults to IntPtr.Zero.
        return Safe(() => cur.CurrentNativeWindowHandle);
    }

    static Dictionary<string, object> Attempt(List<Dictionary<string, object>> attempts, string strategy, System.Action act)
    {
        var sw = Stopwatch.StartNew();
        var rec = new Dictionary<string, object> { { "strategy", strategy } };
        try
        {
            act();
            rec["ok"] = true;
        }
        catch (Exception ex) { rec["ok"] = false; rec["error"] = ex.Message; }
        rec["ms"] = sw.ElapsedMilliseconds;
        attempts.Add(rec);
        return rec;
    }

    /// <summary>
    /// Click a control by selector, UIA first: Invoke/Toggle/Select/ExpandCollapse pattern, then
    /// LegacyIAccessible default action, then UIA SetFocus + Enter (activates where mouse input is
    /// swallowed, e.g. Chromium web content), then a focus-verified SendInput click at the element.
    /// Every rung is recorded; the winner is checked for visible effect (element gone / state changed).
    /// A control pattern that executes without throwing ends the ladder (patterns are authoritative);
    /// the two synthetic rungs (focus-enter, sendinput-click) must show an effect to count.
    /// </summary>
    public static Dictionary<string, object> SmartClick(int pid, string title, string name, string automationId, string controlType,
        int index, string verify, int timeoutMs)
    {
        verify = string.IsNullOrEmpty(verify) ? "auto" : verify.ToLowerInvariant();
        return Run(() =>
        {
            var m = Matches(pid, title, name, automationId, controlType);
            if (m.Count == 0) throw new InvalidOperationException("No element matches " + Selector(name, automationId, controlType) + ". Use uitree to see what is there.");
            if (index >= m.Count) throw new InvalidOperationException(m.Count + " element(s) match " + Selector(name, automationId, controlType) + "; index " + index + " is out of range.");
            // Loose name matches often hit explanatory Text nodes before the real control (lab exp1b):
            // when several match and the caller did not pin an index, try actionable elements first.
            bool reordered = false;
            if (index <= 0 && m.Count > 1)
            {
                var ordered = m.OrderByDescending(HasControlPattern).ToList();
                if (HasControlPattern(ordered[0]) && !HasControlPattern(m[0])) { m = ordered; reordered = true; }
            }
            var e = m[index];
            var before = Describe(e, -1);
            var attempts = new List<Dictionary<string, object>>();
            var result = new Dictionary<string, object>();
            result["element"] = before;
            result["matches"] = m.Count;
            if (reordered) result["selectorNote"] = "multiple matches: actionable-first ordering applied";

            Func<List<IUIAutomationElement>> rematch = () => Safe(() => Matches(pid, title, name, automationId, controlType));
            Func<bool> gone = () => { var m2 = rematch(); return m2 == null || m2.Count == 0; };
            Func<bool> changed = () =>
            {
                var m2 = rematch();
                if (m2 == null || m2.Count <= index) return false;
                var after = Safe(() => Describe(m2[index], -1));
                return after != null && Fingerprint(after) != Fingerprint(before);
            };
            Func<bool> effect = () => gone() || changed();

            string strategy = null;

            // Rung A: native UIA control patterns, most reliable first.
            var inv = Pattern<IUIAutomationInvokePattern>(e, InvokeId);
            if (inv != null && (bool)Attempt(attempts, "uia-invoke", inv.Invoke)["ok"]) strategy = "uia-invoke";
            if (strategy == null)
            {
                var tg = Pattern<IUIAutomationTogglePattern>(e, ToggleId);
                if (tg != null && (bool)Attempt(attempts, "uia-toggle", tg.Toggle)["ok"]) strategy = "uia-toggle";
            }
            if (strategy == null)
            {
                var si = Pattern<IUIAutomationSelectionItemPattern>(e, SelectionItemId);
                if (si != null && (bool)Attempt(attempts, "uia-select", si.Select)["ok"]) strategy = "uia-select";
            }
            if (strategy == null)
            {
                var ec = Pattern<IUIAutomationExpandCollapsePattern>(e, ExpandCollapseId);
                if (ec != null)
                {
                    string strat = null;
                    var rec = Attempt(attempts, "uia-expandcollapse", delegate
                    {
                        if (ec.CurrentExpandCollapseState == ExpandCollapseState.ExpandCollapseState_Collapsed) { ec.Expand(); strat = "expand"; }
                        else { ec.Collapse(); strat = "collapse"; }
                    });
                    if ((bool)rec["ok"]) strategy = strat ?? "uia-expandcollapse";
                }
            }
            if (strategy == null)
            {
                var la = Pattern<IUIAutomationLegacyIAccessiblePattern>(e, LegacyId);
                if (la != null && !string.IsNullOrEmpty(Safe(() => la.CurrentDefaultAction))
                    && (bool)Attempt(attempts, "uia-legacy-default", la.DoDefaultAction)["ok"]) strategy = "uia-legacy-default";
            }

            // Rung B: keyboard activation — UIA SetFocus + Enter. Works on web content that
            // ignores synthesized mouse input (measured on the Google consent dialog).
            if (strategy == null)
            {
                var rec = Attempt(attempts, "focus-enter", delegate
                {
                    e.SetFocus();
                    Thread.Sleep(120);
                    keybd_event(0x0D, 0, 0, IntPtr.Zero);
                    keybd_event(0x0D, 0, 0x2, IntPtr.Zero);
                });
                if ((bool)rec["ok"])
                {
                    Thread.Sleep(350);
                    if (verify == "none" || effect()) strategy = "focus-enter";
                    else rec["ok"] = false; rec["error"] = "no visible effect";
                }
            }

            // Rung C: focus-verified SendInput click at the element.
            if (strategy == null)
            {
                bool focusVerified = false;
                var rec = Attempt(attempts, "sendinput-click", delegate
                {
                    IntPtr top = TopHandle(e);
                    try { e.SetFocus(); } catch { }
                    if (top != IntPtr.Zero) { try { SetForegroundWindow(top); } catch { } }
                    Thread.Sleep(120);
                    IntPtr fg = GetForegroundWindow();
                    focusVerified = top != IntPtr.Zero && fg == top;
                    int x, y;
                    tagPOINT p;
                    if (e.GetClickablePoint(out p) != 0) { x = p.x; y = p.y; }
                    else { tagRECT r = e.CurrentBoundingRectangle; x = (r.left + r.right) / 2; y = (r.top + r.bottom) / 2; }
                    SetCursorPos(x, y); Thread.Sleep(50);
                    mouse_event(0x02u, 0, 0, 0, IntPtr.Zero); mouse_event(0x04u, 0, 0, 0, IntPtr.Zero);
                });
                result["focusVerified"] = focusVerified;
                if ((bool)rec["ok"])
                {
                    Thread.Sleep(350);
                    if (verify == "none" || effect()) strategy = "sendinput-click";
                    else rec["ok"] = false; rec["error"] = "no visible effect";
                }
            }

            Thread.Sleep(200);
            bool isGone = false, isChanged = false;
            if (verify != "none") { isGone = gone(); isChanged = !isGone && changed(); }
            bool verified = verify == "none" ? strategy != null
                : verify == "gone" ? isGone
                : verify == "state" ? isChanged
                : strategy != null && (isGone || isChanged);

            result["strategy"] = strategy;
            result["did"] = strategy;
            result["verified"] = verified;
            result["verifyNote"] = isGone ? "element gone" : isChanged ? "element state changed" : strategy != null ? "no visible state change (pattern executed)" : "no strategy produced an effect";
            result["attempts"] = attempts;
            return result;
        }, timeoutMs, () => { throw new TimeoutException("SmartClick took longer than " + timeoutMs + "ms (app not responding?)"); });
    }

    public static Dictionary<string, object> Wait(int pid, string title, string name, string automationId, string controlType, int timeoutMs)
    {
        return Run(() =>
        {
            var sw = Stopwatch.StartNew();
            while (true)
            {
                List<IUIAutomationElement> m = null;
                try { m = Matches(pid, title, name, automationId, controlType); } catch (InvalidOperationException) { }
                if (m != null && m.Count > 0)
                {
                    var d = Describe(m[0], -1);
                    d["matches"] = m.Count; d["waitedMs"] = sw.ElapsedMilliseconds;
                    return d;
                }
                if (sw.ElapsedMilliseconds > timeoutMs)
                    throw new TimeoutException("Nothing matched " + Selector(name, automationId, controlType) + " within " + timeoutMs + "ms.");
                Thread.Sleep(250);
            }
        }, timeoutMs + 15000, () => { throw new TimeoutException("UI wait did not finish (app not responding?)"); });
    }
}
