using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

internal static class DesktopBridgeSetup {
    internal static void Disable() {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexMobile", "bridge");
        var current = Environment.GetEnvironmentVariable("CODEX_CLI_PATH", EnvironmentVariableTarget.User);
        if (!String.IsNullOrWhiteSpace(current) && Path.GetFullPath(current).StartsWith(Path.Combine(root, "runtime") + "\\", StringComparison.OrdinalIgnoreCase) && String.Equals(Path.GetFileName(current), "CodexMobileBridge.exe", StringComparison.OrdinalIgnoreCase)) {
            var backup = Path.Combine(root, "previous-cli.json");
            var saved = File.Exists(backup) ? Program.Json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(File.ReadAllText(backup)) : null;
            var previous = saved != null && saved.ContainsKey("previous") ? Convert.ToString(saved["previous"]) : null;
            Environment.SetEnvironmentVariable("CODEX_CLI_PATH", String.IsNullOrEmpty(previous) ? null : previous, EnvironmentVariableTarget.User);
        }
    }
    internal static void Configure(string runtime) {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexMobile", "bridge");
        var path = Path.GetFullPath(runtime).TrimEnd('\\');
        if (!path.StartsWith(Path.Combine(root, "runtime") + "\\", StringComparison.OrdinalIgnoreCase) || !File.Exists(Path.Combine(path, "node.exe")) || !File.Exists(Path.Combine(path, "RemoteCompanion.exe")) || !File.Exists(Path.Combine(path, "desktop-bridge.mjs"))) throw new InvalidOperationException("Bridge runtime unavailable");
        Directory.CreateDirectory(root);
        var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(root, security);
        var launcher = Path.Combine(path, "CodexMobileBridge.exe");
        if (!File.Exists(launcher)) throw new InvalidOperationException("Bridge launcher unavailable");
        var current = Environment.GetEnvironmentVariable("CODEX_CLI_PATH", EnvironmentVariableTarget.User);
        if (!String.IsNullOrWhiteSpace(current) && (!Path.GetFullPath(current).StartsWith(Path.Combine(root, "runtime") + "\\", StringComparison.OrdinalIgnoreCase) || !String.Equals(Path.GetFileName(current), "CodexMobileBridge.exe", StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException("An independent custom Codex CLI is configured");
        var backup = Path.Combine(root, "previous-cli.json");
        if (!File.Exists(backup)) File.WriteAllText(backup, Program.Json.Serialize(new { previous = current }));
        Environment.SetEnvironmentVariable("CODEX_CLI_PATH", launcher, EnvironmentVariableTarget.User);
        Console.Write(Program.Json.Serialize(new { configured = true, restartRequired = true }));
    }
}
