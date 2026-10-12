using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
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
    private static readonly BindingFlags Hidden = BindingFlags.Static | BindingFlags.NonPublic;
    private static GroupBox Wrap(UIElement content) { return new GroupBox { Content = content }; }
    private static UIElement Card(string question, bool ambiguous, int depth) {
        var editor = new TextBox(); AutomationProperties.SetName(editor, "Reply…");
        UIElement nested = editor;
        for (int i = 0; i < depth; i++) nested = Wrap(nested);
        var panel = new StackPanel(); panel.Children.Add(new TextBlock { Text = question }); panel.Children.Add(nested);
        panel.Children.Add(new Button { Content = "Skip" }); panel.Children.Add(new Button { Content = "Send" });
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
        var window = new Window { Title = "Question matcher fixture", Width = 500, Height = 400, Left = -30000, Top = -30000, ShowInTaskbar = false };
        var cases = new[] { "shallow", "free-form-deep", "ambiguous", "wrong-question", "wrong-title", "document-boundary", "closed" };
        Exception failure = null;
        window.Loaded += (sender, e) => {
            var handle = new System.Windows.Interop.WindowInteropHelper(window).Handle;
            new Thread(() => {
            try {
                foreach (var sample in cases) {
                    window.Dispatcher.Invoke(new Action(() => {
                        var content = new StackPanel();
                        bool empty = sample == "document-boundary" || sample == "closed";
                        content.Children.Add(Document(sample == "wrong-title" ? "other" : "fixture", empty ? Wrap(new TextBox()) : Card(sample == "wrong-question" ? "Another question" : "单次导入\n 最多多少条？  说明 &amp; 约束", sample == "ambiguous", sample == "shallow" ? 0 : 5)));
                        if (empty) content.Children.Add(Document("unrelated", Card("单次导入 最多多少条？ 说明 & 约束", false, 5)));
                        window.Content = content; window.UpdateLayout();
                    }));
                    var root = AutomationElement.FromHandle(handle);
                    bool found = false;
                    try { type.GetMethod("Find", Hidden).Invoke(null, new object[] { root, request, 0 }); found = true; }
                    catch (TargetInvocationException error) { if (!(error.InnerException is InvalidOperationException)) throw; }
                    if (found != (sample == "shallow" || sample == "free-form-deep")) throw new Exception("Incorrect card matching: " + sample);
                    if (sample == "free-form-deep" || sample == "closed") {
                        var pending = (bool)type.GetMethod("HasQuestion", Hidden).Invoke(null, new object[] { root, request, 0 });
                        if (pending != (sample == "free-form-deep")) throw new Exception("Incorrect submission confirmation: " + sample);
                    }
                    results.Add(sample);
                }
            } catch (Exception error) { failure = error; }
            finally { window.Dispatcher.Invoke(new Action(() => window.Close())); }
            }) { IsBackground = true }.Start();
        };
        application.Run(window);
        if (failure != null) { Console.Error.WriteLine(failure); return 1; }
        Console.WriteLine(new JavaScriptSerializer().Serialize(results)); return 0;
    }
}
