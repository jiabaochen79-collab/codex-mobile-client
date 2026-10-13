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
    internal sealed class Request { public int processId { get; set; } public string startedAt { get; set; } public string executablePath { get; set; } public string title { get; set; } public Answer[] answers { get; set; } public string action { get; set; } public int index { get; set; } }
    private sealed class Result { public bool found { get; set; } public bool filled { get; set; } public bool submitted { get; set; } public bool closed { get; set; } public string error { get; set; } public string stage { get; set; } public string reason { get; set; } }
    private sealed class Card { public AutomationElement editor, submit, panel; }
    private static readonly string[] Editors = { "Reply…", "Reply...", "Or write your own response", "回复…", "回复...", "或自行撰写回复" };
    private static readonly string[] Sends = { "Send", "发送", "Send update", "发送更新" };
    private static readonly string[] Nexts = { "Next", "下一步", "下一个" };
    private static readonly string[] Skips = { "Skip", "跳过" };
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
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
                if (minimized && !process.HasExited && GetWindowThreadProcessId(handle, out owner) != 0 && owner == process.Id && !IsIconic(handle)) ShowWindowAsync(handle, 7);
            } catch (InvalidOperationException) { }
            finally { process.Dispose(); }
        }
    }

    internal static void Run(bool step = false, bool reconcile = false) {
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
                if (step) {
                    if (request.index < 0 || request.index >= request.answers.Length || !new[] { "locate", "fill", "submit", "check", "dismiss" }.Contains(request.action)) throw new InvalidOperationException();
                    stage = "window";
                    var target = Window(request);
                    Automation.AddAutomationPropertyChangedEventHandler(target, TreeScope.Subtree, (sender, change) => { }, AutomationElement.IsEnabledProperty, ValuePattern.ValueProperty);
                    Automation.AddStructureChangedEventHandler(target, TreeScope.Subtree, (sender, change) => { });
                    Thread.Sleep(200);
                    target = Window(request);
                    if (request.action == "check") { writer.WriteLine(Program.Json.Serialize(new { closed = !HasQuestion(target, request, request.index) })); return; }
                    stage = "card";
                    var selected = Find(target, request, request.index);
                    if (request.action == "locate") { writer.WriteLine("{\"found\":true}"); return; }
                    stage = "value-pattern"; object pattern;
                    if (!selected.editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) throw new InvalidOperationException();
                    var currentValue = (ValuePattern)pattern;
                    var currentDraft = currentValue.Current.Value.Trim();
                    stage = "draft";
                    if (!String.IsNullOrEmpty(currentDraft) && !Editors.Contains(currentDraft) && currentDraft != request.answers[request.index].answer) throw new InvalidOperationException();
                    if (request.action == "dismiss") {
                        var dismiss = selected.panel.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)).Cast<AutomationElement>().Where(button => new[] { "Ignore", "Dismiss", "忽略" }.Contains(button.Current.Name)).ToArray();
                        object dismissPattern;
                        if (dismiss.Length != 1 || !dismiss[0].TryGetCurrentPattern(InvokePattern.Pattern, out dismissPattern)) throw new InvalidOperationException();
                        submitting = true;
                        ((InvokePattern)dismissPattern).Invoke(); Thread.Sleep(300);
                        writer.WriteLine("{\"submitted\":true}"); return;
                    }
                    var options = selected.panel.FindAll(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.RadioButton), new PropertyCondition(AutomationElement.NameProperty, request.answers[request.index].answer))).Cast<AutomationElement>().ToArray();
                    SelectionItemPattern option = null;
                    if (options.Length == 1 && options[0].TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) option = (SelectionItemPattern)pattern;
                    if (request.action == "fill") {
                        stage = "value";
                        if (option != null) {
                            // Immediate-response options advance or send the card themselves.
                            submitting = true; option.Select(); Thread.Sleep(300);
                            writer.WriteLine("{\"submitted\":true}"); return;
                        }
                        else if (currentDraft != request.answers[request.index].answer) currentValue.SetValue(request.answers[request.index].answer);
                        Thread.Sleep(300);
                        writer.WriteLine("{\"filled\":true}"); return;
                    }
                    stage = "submit";
                    if (currentDraft != request.answers[request.index].answer && (option == null || !option.Current.IsSelected) || !selected.submit.Current.IsEnabled || !selected.submit.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) throw new InvalidOperationException();
                    submitting = true;
                    ((InvokePattern)pattern).Invoke();
                    Thread.Sleep(4000);
                    writer.WriteLine("{\"submitted\":true}"); return;
                }
                stage = "window";
                window = PrepareWindow(request);
                if (reconcile) {
                    writer.WriteLine("{\"ready\":true}");
                    if (reader.ReadLine() != "submit") return;
                    submitting = true;
                    for (int index = 0; index < request.answers.Length; index++) {
                        request.index = index; request.action = "check";
                        var result = FreshStep(request);
                        if (result.error != null) { writer.WriteLine(Program.Json.Serialize(new { error = "OUTCOME_UNKNOWN", stage = result.stage })); return; }
                        if (result.closed) continue;
                        request.action = "dismiss"; result = FreshStep(request);
                        // Submission can close the card between the read and the dismiss.
                        // Confirm again before reporting a missing card as a failure.
                        request.action = "check";
                        var deadline = Stopwatch.StartNew();
                        do { Thread.Sleep(100); result = FreshStep(request); } while (!result.closed && result.error == null && deadline.ElapsedMilliseconds < 4000);
                        if (!result.closed) { writer.WriteLine("{\"submitted\":true,\"closed\":false}"); return; }
                    }
                    writer.WriteLine("{\"submitted\":true,\"closed\":true}"); return;
                }
                stage = "card";
                request.action = "locate";
                var loading = Stopwatch.StartNew();
                while (true) {
                    var result = FreshStep(request);
                    if (result.found) break;
                    if (result.error != "CLIENT_UNAVAILABLE" || !new[] { "card", "window" }.Contains(result.stage) || loading.ElapsedMilliseconds >= 4000) { writer.WriteLine(Program.Json.Serialize(result)); return; }
                    Thread.Sleep(100);
                }
                writer.WriteLine("{\"ready\":true}");
                if (reader.ReadLine() != "submit") return;
                for (int index = 0; index < request.answers.Length; index++) {
                    request.index = index;
                    if (index > 0) {
                        request.action = "locate";
                        loading.Restart();
                        while (true) {
                            var located = FreshStep(request);
                            if (located.found) break;
                            if (located.error != "CLIENT_UNAVAILABLE" || !new[] { "card", "window" }.Contains(located.stage) || loading.ElapsedMilliseconds >= 4000) { writer.WriteLine(Program.Json.Serialize(located)); return; }
                            Thread.Sleep(100);
                        }
                    }
                    request.action = "fill";
                    var result = Fill(request);
                    if (!result.filled && !result.submitted) { writer.WriteLine(Program.Json.Serialize(result)); return; }
                    if (!result.submitted) {
                        request.action = "submit";
                        var rendered = Stopwatch.StartNew();
                        while (true) {
                            Thread.Sleep(100);
                            result = FreshStep(request);
                            if (result.submitted || result.error != "CLIENT_UNAVAILABLE" || result.stage != "submit" || rendered.ElapsedMilliseconds >= 3000) break;
                            request.action = "fill";
                            result = Fill(request);
                            if (!result.filled) break;
                            request.action = "submit";
                        }
                    }
                    if (!result.submitted) { writer.WriteLine(Program.Json.Serialize(result)); return; }
                    submitting = index == request.answers.Length - 1;
                    request.action = "check";
                    var deadline = Stopwatch.StartNew();
                    while (deadline.ElapsedMilliseconds < 4000) {
                        Thread.Sleep(100);
                        result = FreshStep(request);
                        if (result.error != null) { writer.WriteLine(Program.Json.Serialize(new { error = "OUTCOME_UNKNOWN", stage = result.stage })); return; }
                        if (!result.closed) continue;
                        if (submitting) { writer.WriteLine("{\"submitted\":true,\"closed\":true}"); return; }
                        break;
                    }
                    if (submitting) { writer.WriteLine("{\"submitted\":true,\"closed\":false}"); return; }
                }
            } catch (Exception error) { writer.WriteLine(Program.Json.Serialize(new { error = submitting ? "OUTCOME_UNKNOWN" : "CLIENT_UNAVAILABLE", stage = stage, reason = error.GetType().Name })); }
            finally {
                try { if (step) Automation.RemoveAllEventHandlers(); }
                finally { if (window != null) window.Dispose(); }
            }
        }
    }
    private static Result Fill(Request request) {
        var deadline = Stopwatch.StartNew();
        while (true) {
            var result = FreshStep(request);
            if (result.filled || result.error != "CLIENT_UNAVAILABLE" || !new[] { "card", "value", "value-pattern" }.Contains(result.stage) || deadline.ElapsedMilliseconds >= 3000) return result;
            Thread.Sleep(100);
        }
    }
    private static Result FreshStep(Request request) {
        // Chromium can retain an obsolete UIA tree after editing or invoking a card.
        // Each operation checks the exact card through a new accessibility connection.
        using (var worker = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--desktop-question-step") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, StandardOutputEncoding = Encoding.UTF8 }))
        using (var input = new StreamWriter(worker.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true }) {
            input.WriteLine(Program.Json.Serialize(request));
            var output = worker.StandardOutput.ReadToEndAsync();
            if (!worker.WaitForExit(8000)) { worker.Kill(); return new Result { error = "OUTCOME_UNKNOWN", stage = request.action }; }
            if (worker.ExitCode != 0) return new Result { error = "OUTCOME_UNKNOWN", stage = request.action };
            var result = Program.Json.Deserialize<Result>(output.Result) ?? new Result { error = "OUTCOME_UNKNOWN", stage = request.action };
            return result;
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
            // Keep the coordinator free of UIA references so worker connections can refresh.
            var handle = process.MainWindowHandle;
            if (handle == IntPtr.Zero) {
                var windows = new List<IntPtr>();
                EnumWindows((candidate, parameter) => { uint owner; GetWindowThreadProcessId(candidate, out owner); if (owner == process.Id && IsWindowVisible(candidate)) windows.Add(candidate); return true; }, IntPtr.Zero);
                if (windows.Count != 1) throw new InvalidOperationException();
                handle = windows[0];
            }
            return new WindowLease(process, handle);
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
                candidates.Add(new Card { editor = editor, submit = buttons[0], panel = panel }); break;
            }
        }
        if (candidates.Count != 1) throw new InvalidOperationException();
        return candidates[0];
    }
}
