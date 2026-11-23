using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Security.Principal;
using System.Threading.Tasks;

// A separate lifetime from the assistant: Codex owns this process and its CLI.
internal static class DesktopBridge {
    private static async Task ForwardInput(Stream input, Stream output) {
        var buffer = new byte[16384]; int count;
        while ((count = await input.ReadAsync(buffer, 0, buffer.Length)) > 0) { await output.WriteAsync(buffer, 0, count); await output.FlushAsync(); }
    }
    private static string Quote(string value) {
        var result = new System.Text.StringBuilder("\""); var slashes = 0;
        foreach (var letter in value) {
            if (letter == '\\') { slashes++; continue; }
            result.Append('\\', letter == '"' ? slashes * 2 + 1 : slashes); result.Append(letter); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    private static int Main(string[] args) {
        try {
            var directory = Path.GetDirectoryName(typeof(DesktopBridge).Assembly.Location);
            var start = new ProcessStartInfo(Path.Combine(directory, "node.exe"));
            start.Arguments = Quote(Path.Combine(directory, "desktop-bridge.mjs")) + " " + String.Join(" ", Array.ConvertAll(args, Quote));
            start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            var pid = Process.GetCurrentProcess().Id;
            for (var depth = 0; depth < 6; depth++) {
                using (var process = new ManagementObject("Win32_Process.Handle='" + pid + "'")) {
                    process.Get();
                    var owner = process.InvokeMethod("GetOwnerSid", null, null);
                    if (owner == null || Convert.ToString(owner["Sid"]) != WindowsIdentity.GetCurrent().User.Value || Convert.ToInt32(process["SessionId"]) != Process.GetCurrentProcess().SessionId) break;
                    var executable = Convert.ToString(process["ExecutablePath"]);
                    if (!Convert.ToString(process["CommandLine"]).Contains("--type=") && (String.Equals(Path.GetFileName(executable), "ChatGPT.exe", StringComparison.OrdinalIgnoreCase) || String.Equals(Path.GetFileName(executable), "Codex.exe", StringComparison.OrdinalIgnoreCase)) && File.Exists(Path.Combine(Path.GetDirectoryName(executable), "resources", "app.asar")) && File.Exists(Path.Combine(Path.GetDirectoryName(executable), "resources", "codex.exe"))) {
                        start.EnvironmentVariables["CODEX_MOBILE_DESKTOP_EXE"] = executable;
                        start.EnvironmentVariables["CODEX_MOBILE_DESKTOP_PID"] = pid.ToString();
                        break;
                    }
                    pid = Convert.ToInt32(process["ParentProcessId"]);
                }
            }
            using (var child = Process.Start(start)) {
                var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                // Do not wait for this pump on exit: the desktop may keep stdin open.
                var input = ForwardInput(Console.OpenStandardInput(), child.StandardInput.BaseStream).ContinueWith(t => { var ignored = t.Exception; try { child.StandardInput.Close(); } catch { } });
                child.WaitForExit(); Task.WaitAll(output, error); return child.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine("Codex bridge failed: " + error.GetType().Name); return 1; }
    }
}
