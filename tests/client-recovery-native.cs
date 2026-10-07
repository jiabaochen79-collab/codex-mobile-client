using System;
using System.Diagnostics;
using System.Globalization;
using System.Threading;
internal static class RecoveryFixture {
    static int Main(string[] args) {
        if (args[0] == "child") { Thread.Sleep(1500); return Int32.Parse(args[1], CultureInfo.InvariantCulture); }
        if (args[0] == "resolve") { Console.Write(DesktopRecovery.ResolveApplication()); return 0; }
        if (args[0] == "--desktop-launch") {
            Console.WriteLine("{\"ready\":true}"); Console.Out.Flush();
            if (Console.ReadLine() == "activate") Console.Write("{\"launched\":true}");
            return 0;
        }
        if (args[0] == "pid") {
            uint pid;
            if (!DesktopRecovery.ParseEventPid("0x1234", out pid) || pid != 4660 || !DesktopRecovery.ParseEventPid("4660", out pid) || pid != 4660) throw new Exception("PID decoding failed");
            var self = Process.GetCurrentProcess();
            if (DesktopRecovery.IsCurrentDesktop(self.Id, self.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture))) throw new Exception("Non-Codex process accepted");
            Console.Write("PID and desktop identity verified"); return 0;
        }
        using (var child = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "child " + args[0]) { UseShellExecute = false, CreateNoWindow = true })) {
            var result = DesktopRecovery.ObserveExit(child, "fixture");
            Console.Write(result == null ? "cancelled" : Program.Json.Serialize(result));
            child.WaitForExit();
        }
        return 0;
    }
}
