using System;

class BridgeOwnerFixture {
    static void Main() {
        Console.In.ReadToEnd();
        Console.WriteLine(String.IsNullOrEmpty(Environment.GetEnvironmentVariable("CODEX_MOBILE_DESKTOP_PID")) && String.IsNullOrEmpty(Environment.GetEnvironmentVariable("CODEX_MOBILE_DESKTOP_EXE")) ? "isolated-cli" : "inherited-desktop");
    }
}
