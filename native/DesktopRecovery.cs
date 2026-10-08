using System;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Xml;
using Microsoft.Win32;

internal static class DesktopRecovery {
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ActivationManager { }
    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivationManager {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string app, [MarshalAs(UnmanagedType.LPWStr)] string args, uint options, out uint pid);
    }
    internal static bool IsCurrentDesktop(int pid, string startedAt) {
        using (var process = Process.GetProcessById(pid)) {
            var handle = process.Handle;
            if (process.SessionId != Process.GetCurrentProcess().SessionId || process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != startedAt) return false;
            using (var record = new ManagementObject("Win32_Process.Handle='" + pid + "'")) {
                var owner = record.InvokeMethod("GetOwnerSid", null, null);
                var path = Convert.ToString(record["ExecutablePath"]);
                var name = Path.GetFileName(path);
                return owner != null && Convert.ToString(owner["Sid"]) == WindowsIdentity.GetCurrent().User.Value && path.IndexOf("OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0 &&
                    (String.Equals(name, "ChatGPT.exe", StringComparison.OrdinalIgnoreCase) || String.Equals(name, "Codex.exe", StringComparison.OrdinalIgnoreCase)) && !Convert.ToString(record["CommandLine"]).Contains("--type=");
            }
        }
    }
    internal static object ObserveExit(Process process, string version) {
        int stop = 0, ending = 0;
        SessionEndingEventHandler sessionEnding = (s, e) => Interlocked.Exchange(ref ending, 1);
        SystemEvents.SessionEnding += sessionEnding;
        Task.Run(() => { try { Console.ReadLine(); } catch { } Interlocked.Exchange(ref stop, 1); });
        try {
            // Acquire the process handle before waiting, so PID recycling cannot change the observed exit.
            var handle = process.Handle;
            while (!process.WaitForExit(250)) if (Volatile.Read(ref stop) != 0) return null;
            if (Volatile.Read(ref stop) != 0) return null;
            uint code = unchecked((uint)process.ExitCode);
            string module = null, exception = null;
            if (code != 0 && Volatile.Read(ref ending) == 0) CrashEvent(process.Id, out module, out exception);
            return new { code = "0x" + code.ToString("x8"), at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), version = version, cause = Volatile.Read(ref ending) != 0 ? "session-ending" : code == 0 ? "normal" : "crash", module = module, exception = exception };
        } finally { SystemEvents.SessionEnding -= sessionEnding; }
    }
    private static void CrashEvent(int pid, out string module, out string exception) {
        module = exception = null;
        try {
            var query = new EventLogQuery("Application", PathType.LogName, "*[System[EventID=1000 and TimeCreated[timediff(@SystemTime) <= 120000]]]") { ReverseDirection = true };
            using (var reader = new EventLogReader(query)) {
                for (int i = 0; i < 20; i++) using (var record = reader.ReadEvent(TimeSpan.FromMilliseconds(100))) {
                    if (record == null) break;
                    var xml = new XmlDocument { XmlResolver = null }; xml.LoadXml(record.ToXml());
                    var values = new System.Collections.Generic.Dictionary<string, string>();
                    foreach (XmlNode value in xml.GetElementsByTagName("Data")) if (value.Attributes["Name"] != null) values[value.Attributes["Name"].Value] = value.InnerText;
                    string raw; uint eventPid;
                    if (!values.TryGetValue("ProcessId", out raw) || !ParseEventPid(raw, out eventPid) || eventPid != pid) continue;
                    if (values.TryGetValue("ModuleName", out raw)) module = Path.GetFileName(raw).Substring(0, Math.Min(Path.GetFileName(raw).Length, 100));
                    if (values.TryGetValue("ExceptionCode", out raw) && System.Text.RegularExpressions.Regex.IsMatch(raw, @"^(0x)?[a-fA-F0-9]{8}$")) exception = raw;
                    break;
                }
            }
        } catch { }
    }
    internal static bool ParseEventPid(string raw, out uint pid) {
        bool hex = raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase);
        return UInt32.TryParse(hex ? raw.Substring(2) : raw, hex ? NumberStyles.HexNumber : NumberStyles.Integer, CultureInfo.InvariantCulture, out pid);
    }
    internal static void Watch(string pidText, string startedAt) {
        int pid;
        if (!Int32.TryParse(pidText, out pid) || pid <= 0 || !IsCurrentDesktop(pid, startedAt)) throw new InvalidOperationException("Desktop identity changed");
        using (var process = Process.GetProcessById(pid)) {
            var handle = process.Handle;
            if (process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != startedAt) throw new InvalidOperationException("Desktop identity changed");
            var version = System.Text.RegularExpressions.Regex.Match(process.MainModule.FileName, @"OpenAI\.Codex_([0-9.]+)_").Groups[1].Value;
            var result = ObserveExit(process, version);
            if (result != null) using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) writer.Write(Program.Json.Serialize(result));
        }
    }
    private static bool AlreadyRunning() {
        int session = Process.GetCurrentProcess().SessionId;
        string sid = WindowsIdentity.GetCurrent().User.Value;
        using (var query = new ManagementObjectSearcher("SELECT ProcessId,ExecutablePath,CommandLine,SessionId FROM Win32_Process WHERE Name='ChatGPT.exe' OR Name='Codex.exe'")) {
            foreach (ManagementObject record in query.Get()) {
                try {
                if (Convert.ToInt32(record["SessionId"]) != session || !Convert.ToString(record["ExecutablePath"]).Contains("OpenAI.Codex_") || Convert.ToString(record["CommandLine"]).Contains("--type=")) continue;
                var owner = record.InvokeMethod("GetOwnerSid", null, null);
                if (owner != null && Convert.ToString(owner["Sid"]) == sid) return true;
                } catch (InvalidOperationException) { }
                catch (ManagementException e) { if (e.ErrorCode != ManagementStatus.NotFound) throw; }
            }
        }
        return false;
    }
    internal static string ResolveApplication() {
        string app;
        var script = @"$ErrorActionPreference='Stop'; $p=@(Get-AppxPackage -Name OpenAI.Codex); if($p.Count -ne 1 -or $p[0].Status -ne 'Ok'){throw 'Package unavailable'}; $m=Get-AppxPackageManifest $p[0]; $a=@($m.Package.Applications.Application | Where-Object {$_.Executable -match '(^|[\\/])(ChatGPT|Codex)\.exe$'}); if($a.Count -ne 1){throw 'Application entry unavailable'}; Write-Output ($p[0].PackageFamilyName+'!'+$a[0].Id)";
        using (var resolver = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script))) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true })) {
            var output = resolver.StandardOutput.ReadToEndAsync(); var errors = resolver.StandardError.ReadToEndAsync();
            if (!resolver.WaitForExit(8000)) { resolver.Kill(); throw new TimeoutException("Package lookup timeout"); }
            app = output.Result.Trim();
            if (resolver.ExitCode != 0 || !System.Text.RegularExpressions.Regex.IsMatch(app, @"^OpenAI\.Codex_[a-zA-Z0-9]+![a-zA-Z0-9._-]+$")) throw new InvalidOperationException("Registered Codex application unavailable");
        }
        return app;
    }
    internal static void Launch() {
        string app = ResolveApplication();
        // The helper rechecks authorization after package lookup, immediately before activation.
        Console.WriteLine("{\"ready\":true}"); Console.Out.Flush();
        if (Console.ReadLine() != "activate") return;
        if (AlreadyRunning()) { Console.Write(Program.Json.Serialize(new { alreadyRunning = true })); return; }
        var manager = (IActivationManager)new ActivationManager();
        try { uint pid; Marshal.ThrowExceptionForHR(manager.ActivateApplication(app, null, 0, out pid)); Console.Write(Program.Json.Serialize(new { launched = true })); }
        finally { Marshal.ReleaseComObject(manager); }
    }
}
