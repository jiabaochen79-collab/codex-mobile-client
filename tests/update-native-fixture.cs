using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;

internal static class UpdateFixture {
    private static int Main(string[] args) {
        if (args.Length > 0 && args[0] == "--update-health") {
            using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\CodexMobileCompanion.UpdateExit." + Process.GetCurrentProcess().Id)) {
                var node = Process.Start(new ProcessStartInfo(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "node.exe"), "-e \"setTimeout(()=>{},30000)\"") { UseShellExecute = false, CreateNoWindow = true });
                Console.WriteLine(Program.Json.Serialize(new { pid = Process.GetCurrentProcess().Id, nodePid = node.Id }));
                Console.Out.Flush();
                signal.WaitOne(30000);
            }
            return 0;
        }
        return (int)typeof(Program).GetMethod("Main", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { args });
    }
}
