using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;
using System.Windows.Automation;

// Submit through the question card so the desktop also records its submission.
internal static class DesktopQuestion {
    internal sealed class Answer { public string question { get; set; } public string answer { get; set; } }
    internal sealed class Request { public int processId { get; set; } public string startedAt { get; set; } public string executablePath { get; set; } public string title { get; set; } public Answer[] answers { get; set; } }
    private sealed class Card { public AutomationElement editor, submit; }
    private static readonly string[] Editors = { "Reply…", "Reply...", "Or write your own response", "回复…", "回复...", "或自行撰写回复" };
    private static readonly string[] Sends = { "Send", "发送" };
    private static readonly string[] Nexts = { "Next", "下一步", "下一个" };
    private static readonly string[] Skips = { "Skip", "跳过" };
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    private sealed class WindowLease : IDisposable {
        private readonly Process process;
        private readonly IntPtr handle;
        private readonly bool minimized;
        internal WindowLease(Process process, IntPtr handle) {
            this.process = process;
            this.handle = handle;
            try {
                uint owner;
                if (handle == IntPtr.Zero || GetWindowThreadProcessId(handle, out owner) == 0 || owner != process.Id) throw new InvalidOperationException();
                minimized = IsIconic(handle);
                // Chromium may stop updating the question view while minimized.
                if (minimized && !ShowWindowAsync(handle, 4)) throw new InvalidOperationException();
            } catch { process.Dispose(); throw; }
        }
        public void Dispose() {
            try {
                uint owner;
                if (minimized && !process.HasExited && GetWindowThreadProcessId(handle, out owner) != 0 && owner == process.Id && GetForegroundWindow() != handle && !IsIconic(handle)) ShowWindowAsync(handle, 7);
            } catch (InvalidOperationException) { }
            finally { process.Dispose(); }
        }
    }

    internal static void Run() {
        bool submitting = false;
        string stage = "input";
        WindowLease window = null;
        using (var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8))
        using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true }) {
            try {
                var input = reader.ReadLine();
                if (input == null || input.Length > 40000) throw new InvalidOperationException();
                var request = Program.Json.Deserialize<Request>(input);
                if (request == null || String.IsNullOrWhiteSpace(request.title) || request.answers == null || request.answers.Length < 1 || request.answers.Any(a => a == null || String.IsNullOrWhiteSpace(a.question) || String.IsNullOrWhiteSpace(a.answer) || a.answer.Length > 4000)) throw new InvalidOperationException();
                stage = "window";
                window = PrepareWindow(request);
                stage = "card";
                AutomationElement root = null; Card card = null;
                var loading = Stopwatch.StartNew();
                while (card == null) {
                    try { stage = "window"; root = Window(request); stage = "card"; card = Find(root, request, 0); }
                    catch (InvalidOperationException) { if (loading.ElapsedMilliseconds >= 4000) throw; Thread.Sleep(100); }
                }
                writer.WriteLine("{\"ready\":true}");
                if (reader.ReadLine() != "submit") return;
                for (int index = 0; index < request.answers.Length; index++) {
                    stage = "window"; root = Window(request);
                    stage = "card";
                    card = Find(root, request, index);
                    stage = "value-pattern"; object raw;
                    if (!card.editor.TryGetCurrentPattern(ValuePattern.Pattern, out raw)) throw new InvalidOperationException();
                    var value = (ValuePattern)raw;
                    var draft = value.Current.Value.Trim();
                    stage = "draft";
                    if (!String.IsNullOrEmpty(draft) && !Editors.Contains(draft) && draft != request.answers[index].answer) throw new InvalidOperationException();
                    stage = "value";
                    value.SetValue(request.answers[index].answer);
                    stage = "submit";
                    var rendered = Stopwatch.StartNew();
                    do { Thread.Sleep(100); card = Find(Window(request), request, index); } while (!card.submit.Current.IsEnabled && rendered.ElapsedMilliseconds < 2000);
                    if (!card.submit.Current.IsEnabled || !card.submit.TryGetCurrentPattern(InvokePattern.Pattern, out raw)) throw new InvalidOperationException();
                    submitting = index == request.answers.Length - 1;
                    ((InvokePattern)raw).Invoke();
                    var deadline = Stopwatch.StartNew();
                    while (deadline.ElapsedMilliseconds < 4000) {
                        Thread.Sleep(100);
                        if (submitting) {
                            if (!HasQuestion(Window(request), request, index)) { writer.WriteLine("{\"submitted\":true,\"closed\":true}"); return; }
                        } else {
                            try { Find(Window(request), request, index + 1); break; } catch (InvalidOperationException) { }
                        }
                    }
                    if (submitting) { writer.WriteLine("{\"submitted\":true,\"closed\":false}"); return; }
                }
            } catch (Exception error) { writer.WriteLine(Program.Json.Serialize(new { error = submitting ? "OUTCOME_UNKNOWN" : "CLIENT_UNAVAILABLE", stage = stage, reason = error.GetType().Name })); }
            finally { if (window != null) window.Dispose(); }
        }
    }
    private static Process CheckedProcess(Request request) {
        var process = Process.GetProcessById(request.processId);
        try {
            if (process.SessionId != Process.GetCurrentProcess().SessionId || process.HasExited || !String.Equals(process.MainModule.FileName, request.executablePath, StringComparison.OrdinalIgnoreCase) || !request.executablePath.Contains("OpenAI.Codex_")) throw new InvalidOperationException();
            using (var identity = new ManagementObject("Win32_Process.Handle='" + request.processId + "'")) {
                var owner = identity.InvokeMethod("GetOwnerSid", null, null);
                if (owner == null || Convert.ToString(owner["Sid"]) != System.Security.Principal.WindowsIdentity.GetCurrent().User.Value || process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != request.startedAt) throw new InvalidOperationException();
            }
            return process;
        } catch { process.Dispose(); throw; }
    }
    private static AutomationElement Window(Request request) {
        using (var process = CheckedProcess(request)) {
            var windows = AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ProcessIdProperty, request.processId));
            var candidates = windows.Cast<AutomationElement>().Where(w => w.FindAll(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document), new PropertyCondition(AutomationElement.NameProperty, request.title))).Count == 1).ToArray();
            if (candidates.Length != 1) throw new InvalidOperationException();
            return candidates[0];
        }
    }
    private static WindowLease PrepareWindow(Request request) {
        var process = CheckedProcess(request);
        try {
            var windows = AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ProcessIdProperty, request.processId)).Cast<AutomationElement>().Where(w => w.Current.NativeWindowHandle != 0).ToArray();
            var matches = windows.Where(w => w.FindAll(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document), new PropertyCondition(AutomationElement.NameProperty, request.title))).Count == 1).ToArray();
            var target = matches.Length == 1 ? matches[0] : matches.Length == 0 && windows.Length == 1 ? windows[0] : null;
            if (target == null) throw new InvalidOperationException();
            return new WindowLease(process, new IntPtr(target.Current.NativeWindowHandle));
        } catch { process.Dispose(); throw; }
    }
    private static bool Named(AutomationElement element, ControlType type, string[] names) { return element.Current.ControlType == type && names.Contains(element.Current.Name); }
    private static string QuestionText(string text) { return Regex.Replace(System.Net.WebUtility.HtmlDecode(text), @"\s+", " ").Trim(); }
    private static bool HasQuestion(AutomationElement root, Request request, int index) {
        var document = root.FindFirst(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document), new PropertyCondition(AutomationElement.NameProperty, request.title)));
        if (document == null) throw new InvalidOperationException();
        return document.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)).Cast<AutomationElement>().Where(e => Editors.Contains(e.Current.Name)).Any(e => {
            var panel = TreeWalker.ControlViewWalker.GetParent(e);
            for (int i = 0; i < 8 && panel != null && panel.Current.ControlType != ControlType.Document; i++, panel = TreeWalker.ControlViewWalker.GetParent(panel)) {
                if (panel.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)).Cast<AutomationElement>().Any(text => QuestionText(text.Current.Name) == QuestionText(request.answers[index].question))) return true;
            }
            return false;
        });
    }
    private static Card Find(AutomationElement root, Request request, int index) {
        var document = root.FindFirst(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document), new PropertyCondition(AutomationElement.NameProperty, request.title)));
        if (document == null) throw new InvalidOperationException();
        var candidates = new List<Card>();
        foreach (AutomationElement editor in document.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit))) {
            if (!Editors.Contains(editor.Current.Name)) continue;
            var panel = TreeWalker.ControlViewWalker.GetParent(editor);
            for (int depth = 0; depth < 8 && panel != null && panel.Current.ControlType != ControlType.Document; depth++, panel = TreeWalker.ControlViewWalker.GetParent(panel)) {
                var descendants = panel.FindAll(TreeScope.Descendants, Condition.TrueCondition).Cast<AutomationElement>().ToArray();
                if (!descendants.Any(e => e.Current.ControlType == ControlType.Text && QuestionText(e.Current.Name) == QuestionText(request.answers[index].question)) || !descendants.Any(e => Named(e, ControlType.Button, Skips))) continue;
                var buttons = descendants.Where(e => Named(e, ControlType.Button, index == request.answers.Length - 1 ? Sends : Nexts)).ToArray();
                if (buttons.Length != 1 || descendants.Count(e => Named(e, ControlType.Edit, Editors)) != 1) throw new InvalidOperationException();
                candidates.Add(new Card { editor = editor, submit = buttons[0] }); break;
            }
        }
        if (candidates.Count != 1) throw new InvalidOperationException();
        return candidates[0];
    }
}
