using System;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;

internal static class PowerSettingsChecks {
    private static int checks;
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; }
    private static PowerConfiguration Desktop() { return new PowerConfiguration { Scheme = "fixture", CanSleep = true, AcSleep = 0, DcSleep = 600, AcHibernate = 0, DcHibernate = 900, AcLid = 1, DcLid = 1 }; }
    private static int Main() {
        try {
            Check(Marshal.SizeOf(typeof(PowerSettings).GetNestedType("Capabilities", BindingFlags.NonPublic)) == 76, "Native structure size");
            var data = Desktop(); var result = PowerSettings.Assess(data);
            Check(!result.Risk && result.Available, "Desktop ignores battery and absent lid");
            data.AcSleep = 600; result = PowerSettings.Assess(data); Check(result.Risk && result.Summary.Contains("接电空闲 10 分钟"), "AC sleep risk");
            data.AcSleep = 45; Check(PowerSettings.Assess(data).Summary.Contains("45 秒"), "Sub-minute timeout");
            data = Desktop(); data.CanHibernate = true; data.AcHibernate = 1200; Check(PowerSettings.Assess(data).Summary.Contains("20 分钟后休眠"), "Hibernate risk");
            data.CanHibernate = false; Check(!PowerSettings.Assess(data).Risk, "Disabled hibernation ignored");
            data = Desktop(); data.HasBattery = true; Check(PowerSettings.Assess(data).Summary.Contains("电池"), "Battery-only risk");
            data = Desktop(); data.HasLid = true; Check(PowerSettings.Assess(data).Summary.Contains("合盖"), "Laptop lid risk");
            data.AcLid = 3; Check(PowerSettings.Assess(data).Summary.Contains("关机"), "Lid shutdown risk");
            data = Desktop(); data.CanSleep = false; data.AcSleep = 600; Check(!PowerSettings.Assess(data).Risk, "Unavailable sleep ignored");
            data = Desktop(); data.AcSleep = null; Check(!PowerSettings.Assess(data).Available, "Missing settings cannot be called safe");
            data = Desktop(); data.HasLid = true; data.AcLid = 9; Check(!PowerSettings.Assess(data).Available, "Unknown lid action");
            data = Desktop(); data.ModernStandby = true; Check(PowerSettings.Assess(data).Detail.Contains("现代待机"), "Modern standby qualification");
            data = Desktop(); var key = PowerSettings.Assess(data).Fingerprint; Check(PowerSettings.Assess(data).Fingerprint == key, "Stable notification identity"); data.AcSleep = 60; Check(PowerSettings.Assess(data).Fingerprint != key, "Updated notification identity");
            Console.WriteLine(checks); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
