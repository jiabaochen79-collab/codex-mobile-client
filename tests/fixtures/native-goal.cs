using System;
using System.Diagnostics;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Interop;

internal static class GoalFixture {
    private static void Probe(IntPtr handle, bool disabled) {
        var root = AutomationElement.FromHandle(handle);
        if (!disabled) foreach (var action in new[] { "resume", "clear" }) {
            var selected = DesktopGoal.FindButton(root, action, "Only this goal");
            if (selected.Current.Name != (action == "resume" ? "Resume goal" : "Clear goal")) throw new Exception("Wrong control");
        }
        bool refused = false;
        try { DesktopGoal.FindButton(root, "clear", disabled ? "Only this goal" : "A different goal"); } catch (InvalidOperationException) { refused = true; }
        if (!refused) throw new Exception("Unrelated or disabled goal accepted");
    }
    private static void Worker(IntPtr handle, bool disabled) {
        using (var child = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--probe " + handle.ToInt64() + " " + disabled) { UseShellExecute = false, CreateNoWindow = true })) {
            if (!child.WaitForExit(10000)) { child.Kill(); throw new Exception("Probe timeout"); }
            if (child.ExitCode != 0) throw new Exception("Probe failed");
        }
    }
    [STAThread]
    private static void Main(string[] args) {
        if (args.Length == 3 && args[0] == "--probe") {
            try { Probe(new IntPtr(Int64.Parse(args[1])), Boolean.Parse(args[2])); } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
            return;
        }
        var app = new Application();
        var form = new Window { Title = "Isolated goal controls", Width = 420, Height = 200, ShowActivated = false };
        var row = new StackPanel();
        var label = new TextBlock { Text = "Only  this\ngoal •" };
        var resume = new Button { Content = "Resume goal" };
        var clear = new Button { Content = "Clear goal" };
        row.Children.Add(label); row.Children.Add(resume); row.Children.Add(clear);
        form.Content = new GroupBox { Header = "Goal controls", Content = row };
        int clicked = 0; resume.Click += (sender, e) => clicked++; clear.Click += (sender, e) => clicked++;
        form.Loaded += (sender, e) => {
            var handle = new WindowInteropHelper(form).Handle;
            var worker = new Thread(() => {
                try {
                    Worker(handle, false);
                    form.Dispatcher.Invoke(new Action(() => clear.IsEnabled = false));
                    Worker(handle, true);
                    if (clicked != 0) throw new Exception("Unexpected invocation");
                    Console.WriteLine("goal-controls-ok");
                } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
                finally { form.Dispatcher.BeginInvoke(new Action(() => form.Close())); }
            });
            worker.SetApartmentState(ApartmentState.MTA); worker.Start();
        };
        app.Run(form);
    }
}
