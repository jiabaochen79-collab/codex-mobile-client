using System;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

internal static class HelperDiagnosticsFixture {
    [DllImport("kernel32.dll")] private static extern uint SetErrorMode(uint mode);
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Fail() { throw new InvalidOperationException("fixture-private-value https://private.invalid/ password=fixture-value"); }
    static int Main(string[] args) {
        SetErrorMode(2);
        if (args[0] == "blocked") Directory.CreateDirectory(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data-blocked", "CodexMobile", "logs", "helper-lifecycle.jsonl"));
        Program.EnableHelperDiagnostics(); Program.LogHelperEvent("helper.started");
        if (args[0] == "fatal") { Fail(); return 1; }
        try { Fail(); } catch (Exception e) { Program.LogHelperEvent("helper.failed", null, e); }
        return 0;
    }
}
