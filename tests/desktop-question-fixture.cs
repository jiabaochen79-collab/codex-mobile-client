using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;

internal sealed class QuestionDocument : ContentControl {
    protected override AutomationPeer OnCreateAutomationPeer() { return new DocumentPeer(this); }
    private sealed class DocumentPeer : FrameworkElementAutomationPeer {
        internal DocumentPeer(QuestionDocument owner) : base(owner) { }
        protected override AutomationControlType GetAutomationControlTypeCore() { return AutomationControlType.Document; }
    }
}
internal static class QuestionFixture {
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    private static readonly BindingFlags Hidden = BindingFlags.Static | BindingFlags.NonPublic;
    private static Action<string> onSubmit;
    private static GroupBox Wrap(UIElement content) { return new GroupBox { Content = content }; }
    private static UIElement Card(string question, bool ambiguous, int depth) {
        var editor = new TextBox(); AutomationProperties.SetName(editor, "Reply…");
        UIElement nested = editor;
        for (int i = 0; i < depth; i++) nested = Wrap(nested);
        var panel = new StackPanel(); panel.Children.Add(new TextBlock { Text = question }); panel.Children.Add(nested);
        panel.Children.Add(new Button { Content = "Skip" });
        var send = new Button { Content = "Send", IsEnabled = false };
        editor.TextChanged += (sender, e) => send.IsEnabled = editor.Text.Length > 0;
        send.Click += (sender, e) => { if (onSubmit != null) onSubmit(editor.Text); };
        panel.Children.Add(send);
        var dismiss = new Button { Content = "Ignore" };
        dismiss.Click += (sender, e) => { if (onSubmit != null) onSubmit("dismissed"); };
        panel.Children.Add(dismiss);
        if (ambiguous) { var other = new TextBox(); AutomationProperties.SetName(other, "Reply…"); panel.Children.Add(other); }
        return Wrap(panel);
    }
    private static QuestionDocument Document(string title, UIElement content) {
        var document = new QuestionDocument { Content = content }; AutomationProperties.SetName(document, title); return document;
    }
    [STAThread]
    private static int Main(string[] args) {
        var type = Assembly.LoadFrom(args[0]).GetType("DesktopQuestion");
        var requestType = type.GetNestedType("Request", BindingFlags.NonPublic);
        var request = new JavaScriptSerializer().Deserialize("{\"title\":\"fixture\",\"answers\":[{\"question\":\"单次导入 最多多少条？ 说明 & 约束\",\"answer\":\"最多10万\"}]}", requestType);
        var results = new List<string>(); var application = new Application();
        var window = new Window { Title = "Question matcher fixture", Width = 500, Height = 400, Left = -30000, Top = -30000, ShowInTaskbar = false, ShowActivated = false };
        var cases = new[] { "shallow", "free-form-deep", "minimized", "ambiguous", "wrong-question", "wrong-title", "document-boundary", "closed" };
        Exception failure = null;
        window.Loaded += (sender, e) => {
            var handle = new System.Windows.Interop.WindowInteropHelper(window).Handle;
            new Thread(() => {
            try {
                foreach (var sample in cases) {
                    window.Dispatcher.Invoke(new Action(() => {
                        window.WindowState = WindowState.Normal;
                        var content = new StackPanel();
                        bool empty = sample == "document-boundary" || sample == "closed";
                        content.Children.Add(Document(sample == "wrong-title" ? "other" : "fixture", empty ? Wrap(new TextBox()) : Card(sample == "wrong-question" ? "Another question" : "单次导入\n 最多多少条？  说明 &amp; 约束", sample == "ambiguous", sample == "shallow" ? 0 : 5)));
                        if (empty) content.Children.Add(Document("unrelated", Card("单次导入 最多多少条？ 说明 & 约束", false, 5)));
                        window.Content = content; window.UpdateLayout();
                        if (sample == "minimized") window.WindowState = WindowState.Minimized;
                    }));
                    var root = AutomationElement.FromHandle(handle);
                    bool found = false;
                    try { type.GetMethod("Find", Hidden).Invoke(null, new object[] { root, request, 0 }); found = true; }
                    catch (TargetInvocationException error) { if (!(error.InnerException is InvalidOperationException)) throw; }
                    if (found != (sample == "shallow" || sample == "free-form-deep" || sample == "minimized")) throw new Exception("Incorrect card matching: " + sample);
                    if (sample == "free-form-deep" || sample == "closed") {
                        var pending = (bool)type.GetMethod("HasQuestion", Hidden).Invoke(null, new object[] { root, request, 0 });
                        if (pending != (sample == "free-form-deep")) throw new Exception("Incorrect submission confirmation: " + sample);
                    }
                    results.Add(sample);
                }
                window.Dispatcher.Invoke(new Action(() => {
                    window.Content = Document("fixture", Card("单次导入 最多多少条？ 说明 & 约束", false, 5));
                    window.WindowState = WindowState.Minimized;
                }));
                Thread.Sleep(100);
                var foreground = GetForegroundWindow();
                var leaseType = type.GetNestedType("WindowLease", BindingFlags.NonPublic);
                using (var lease = (IDisposable)Activator.CreateInstance(leaseType, BindingFlags.Instance | BindingFlags.NonPublic, null, new object[] { Process.GetCurrentProcess(), handle }, null)) {
                    var ready = Stopwatch.StartNew();
                    while ((bool)window.Dispatcher.Invoke(new Func<bool>(() => window.WindowState == WindowState.Minimized)) && ready.ElapsedMilliseconds < 2000) Thread.Sleep(20);
                    if ((bool)window.Dispatcher.Invoke(new Func<bool>(() => window.WindowState == WindowState.Minimized))) throw new Exception("Window did not recover");
                    if (GetForegroundWindow() != foreground) throw new Exception("Window restoration changed foreground");
                    type.GetMethod("Find", Hidden).Invoke(null, new object[] { AutomationElement.FromHandle(handle), request, 0 });
                }
                var restored = Stopwatch.StartNew();
                while (!(bool)window.Dispatcher.Invoke(new Func<bool>(() => window.WindowState == WindowState.Minimized)) && restored.ElapsedMilliseconds < 2000) Thread.Sleep(20);
                if (!(bool)window.Dispatcher.Invoke(new Func<bool>(() => window.WindowState == WindowState.Minimized))) throw new Exception("Original minimized state was not restored");
                results.Add("minimized-window-recovery");
                string answer = null;
                window.Dispatcher.Invoke(new Action(() => {
                    window.WindowState = WindowState.Minimized;
                    onSubmit = text => { answer = text; window.Content = Document("fixture", new TextBlock { Text = "Submitted" }); };
                    window.Content = Document("fixture", Card("单次导入 最多多少条？ 说明 & 约束", false, 5));
                }));
                using (var process = Process.GetCurrentProcess())
                using (var helper = Process.Start(new ProcessStartInfo(args[0], "--desktop-question") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, StandardOutputEncoding = System.Text.Encoding.UTF8 }))
                using (var input = new System.IO.StreamWriter(helper.StandardInput.BaseStream, new System.Text.UTF8Encoding(false)) { AutoFlush = true }) {
                    input.WriteLine(new JavaScriptSerializer().Serialize(new { processId = process.Id, executablePath = process.MainModule.FileName, startedAt = process.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture), title = "fixture", answers = new[] { new { question = "单次导入 最多多少条？ 说明 & 约束", answer = "最多10万" } } }));
                    if (helper.StandardOutput.ReadLine() != "{\"ready\":true}") throw new Exception("Native preparation failed");
                    input.WriteLine("submit");
                    if (helper.StandardOutput.ReadLine() != "{\"submitted\":true,\"closed\":true}") throw new Exception("Native card did not close");
                    if (!helper.WaitForExit(5000) || helper.ExitCode != 0 || answer != "最多10万") throw new Exception("Native answer was not delivered");
                    var settled = Stopwatch.StartNew();
                    while (!(bool)window.Dispatcher.Invoke(new Func<bool>(() => window.WindowState == WindowState.Minimized)) && settled.ElapsedMilliseconds < 2000) Thread.Sleep(20);
                    if (!(bool)window.Dispatcher.Invoke(new Func<bool>(() => window.WindowState == WindowState.Minimized))) throw new Exception("Native submission changed the minimized state");
                }
                results.Add("native-submission");
                window.Dispatcher.Invoke(new Action(() => {
                    onSubmit = text => { answer = text; window.Content = Document("fixture", new TextBlock { Text = "Dismissed" }); };
                    window.Content = Document("fixture", Card("单次导入 最多多少条？ 说明 & 约束", false, 5));
                }));
                using (var process = Process.GetCurrentProcess())
                using (var helper = Process.Start(new ProcessStartInfo(args[0], "--desktop-question-reconcile") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true }))
                using (var input = new System.IO.StreamWriter(helper.StandardInput.BaseStream, new System.Text.UTF8Encoding(false)) { AutoFlush = true }) {
                    input.WriteLine(new JavaScriptSerializer().Serialize(new { processId = process.Id, executablePath = process.MainModule.FileName, startedAt = process.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture), title = "fixture", answers = new[] { new { question = "单次导入 最多多少条？ 说明 & 约束", answer = "最多10万" } } }));
                    if (helper.StandardOutput.ReadLine() != "{\"ready\":true}") throw new Exception("Reconciliation preparation failed");
                    input.WriteLine("submit");
                    if (helper.StandardOutput.ReadLine() != "{\"submitted\":true,\"closed\":true}") throw new Exception("Reconciliation did not close the card");
                    if (!helper.WaitForExit(5000) || helper.ExitCode != 0 || answer != "dismissed") throw new Exception("Reconciliation sent or changed an answer");
                }
                results.Add("native-reconciliation");
            } catch (Exception error) { failure = error; }
            finally { window.Dispatcher.Invoke(new Action(() => window.Close())); }
            }) { IsBackground = true }.Start();
        };
        application.Run(window);
        if (failure != null) { Console.Error.WriteLine(failure); return 1; }
        Console.WriteLine(new JavaScriptSerializer().Serialize(results)); return 0;
    }
}
