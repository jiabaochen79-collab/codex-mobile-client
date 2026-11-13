using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

internal static class DesktopGoal {
    private sealed class Request : DesktopQuestion.Request { public string objective { get; set; } }
    private static readonly string[] Resume = { "Resume goal", "恢复目标", "继续目标", "繼續目標", "恢復目標" };
    private static readonly string[] Clear = { "Clear goal", "清除目标", "清空目标", "清除目標", "清空目標" };
    internal static void Run() {
        var thread = new Thread(RunCore); thread.SetApartmentState(ApartmentState.MTA); thread.Start(); thread.Join();
    }
    private static string Text(string value) { return Regex.Replace(value ?? "", @"\s+", " ").Trim().TrimEnd('•').TrimEnd(); }
    private static AutomationElement Button(Request request) {
        var window = DesktopQuestion.Window(request);
        var document = window.FindFirst(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document), new PropertyCondition(AutomationElement.NameProperty, request.title)));
        return FindButton(document, request.action, request.objective);
    }
    internal static AutomationElement FindButton(AutomationElement document, string action, string objective) {
        var names = action == "resume" ? Resume : Clear;
        var buttons = document.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)).Cast<AutomationElement>().Where(button => names.Contains(button.Current.Name) && button.Current.IsControlElement && button.Current.IsEnabled && !button.Current.IsOffscreen).Where(button => {
            var parent = TreeWalker.ControlViewWalker.GetParent(button);
            for (int i = 0; i < 6 && parent != null && !Automation.Compare(parent, document) && parent.Current.ControlType != ControlType.Document; i++, parent = TreeWalker.ControlViewWalker.GetParent(parent)) {
                if (parent.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)).Cast<AutomationElement>().Any(text => Text(text.Current.Name) == Text(objective))) return true;
            }
            return false;
        }).ToArray();
        if (buttons.Length != 1 || !buttons[0].Current.IsEnabled) throw new InvalidOperationException();
        return buttons[0];
    }
    private static void RunCore() {
        bool submitting = false;
        using (var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8))
        using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true }) {
            try {
                var input = reader.ReadLine();
                if (input == null || input.Length > 40000) throw new InvalidOperationException();
                var request = Program.Json.Deserialize<Request>(input);
                if (request == null || String.IsNullOrWhiteSpace(request.title) || String.IsNullOrWhiteSpace(request.objective) || request.objective.Length > 32000 || !new[] { "resume", "clear" }.Contains(request.action)) throw new InvalidOperationException();
                using (DesktopQuestion.PrepareWindow(request)) {
                    Button(request);
                    writer.WriteLine("{\"ready\":true}");
                    if (reader.ReadLine() != "submit") return;
                    // Reacquire after the helper has checked the current goal revision
                    // and authorization; never invoke a stale UIA element.
                    var button = Button(request); object pattern;
                    if (!button.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) throw new InvalidOperationException();
                    submitting = true; ((InvokePattern)pattern).Invoke();
                    writer.WriteLine("{\"submitted\":true}");
                }
            } catch { writer.WriteLine(Program.Json.Serialize(new { error = submitting ? "OUTCOME_UNKNOWN" : "CLIENT_UNAVAILABLE" })); }
        }
    }
}
