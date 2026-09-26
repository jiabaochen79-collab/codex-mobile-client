using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

internal sealed class PowerConfiguration {
    public string Scheme;
    public bool HasBattery, HasLid, CanSleep, CanHibernate, ModernStandby;
    public uint? AcSleep, DcSleep, AcHibernate, DcHibernate, AcLid, DcLid;
}

internal sealed class PowerAssessment {
    public bool Available;
    public bool Risk;
    public string Summary;
    public string Detail;
    public string Fingerprint;
}

internal static class PowerSettings {
    private static readonly Guid SleepGroup = new Guid("238c9fa8-0aad-41ed-83f4-97be242c8f20");
    private static readonly Guid SleepIdle = new Guid("29f6c1db-86da-48c5-9fdb-f2b67b1f44da");
    private static readonly Guid HibernateIdle = new Guid("9d7815a6-7ee4-497e-8888-515a05f02364");
    private static readonly Guid ButtonsGroup = new Guid("4f971e89-eebd-4455-a8de-9e59040e7347");
    private static readonly Guid LidAction = new Guid("5ca83367-6e45-459f-a27b-476b1d01c936");
    [StructLayout(LayoutKind.Sequential)]
    private struct BatteryScale { public uint Granularity, Capacity; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Capabilities {
        public byte PowerButtonPresent, SleepButtonPresent, LidPresent, SystemS1, SystemS2, SystemS3, SystemS4, SystemS5;
        public byte HiberFilePresent, FullWake, VideoDimPresent, ApmPresent, UpsPresent, ThermalControl, ProcessorThrottle, ProcessorMinThrottle;
        public byte ProcessorMaxThrottle, FastSystemS4, Hiberboot, WakeAlarmPresent, AoAc, DiskSpinDown, HiberFileType, AoAcConnectivitySupported;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public byte[] Spare;
        public byte SystemBatteriesPresent, BatteriesAreShortTerm;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 3)] public BatteryScale[] BatteryScales;
        public uint AcOnLineWake, SoftLidWake, RtcWake, MinDeviceWakeState, DefaultLowLatencyWake;
    }
    [DllImport("powrprof.dll")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool GetPwrCapabilities(out Capabilities capabilities);
    [DllImport("powrprof.dll")]
    private static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr scheme);
    [DllImport("powrprof.dll")]
    private static extern uint PowerReadACValueIndex(IntPtr root, ref Guid scheme, ref Guid subgroup, ref Guid setting, out uint value);
    [DllImport("powrprof.dll")]
    private static extern uint PowerReadDCValueIndex(IntPtr root, ref Guid scheme, ref Guid subgroup, ref Guid setting, out uint value);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    private static uint? Value(Guid scheme, Guid group, Guid setting, bool battery) {
        uint value;
        uint error = battery ? PowerReadDCValueIndex(IntPtr.Zero, ref scheme, ref group, ref setting, out value) : PowerReadACValueIndex(IntPtr.Zero, ref scheme, ref group, ref setting, out value);
        return error == 0 ? (uint?)value : null;
    }
    internal static PowerAssessment Read() {
        IntPtr pointer = IntPtr.Zero;
        try {
            Capabilities capabilities;
            if (!GetPwrCapabilities(out capabilities) || PowerGetActiveScheme(IntPtr.Zero, out pointer) != 0 || pointer == IntPtr.Zero) return Unknown();
            var scheme = (Guid)Marshal.PtrToStructure(pointer, typeof(Guid));
            var data = new PowerConfiguration {
                Scheme = scheme.ToString(), HasBattery = capabilities.SystemBatteriesPresent != 0, HasLid = capabilities.LidPresent != 0,
                CanSleep = capabilities.SystemS1 != 0 || capabilities.SystemS2 != 0 || capabilities.SystemS3 != 0 || capabilities.AoAc != 0,
                CanHibernate = capabilities.SystemS4 != 0 && capabilities.HiberFilePresent != 0, ModernStandby = capabilities.AoAc != 0,
                AcSleep = Value(scheme, SleepGroup, SleepIdle, false), DcSleep = Value(scheme, SleepGroup, SleepIdle, true),
                AcHibernate = Value(scheme, SleepGroup, HibernateIdle, false), DcHibernate = Value(scheme, SleepGroup, HibernateIdle, true),
                AcLid = Value(scheme, ButtonsGroup, LidAction, false), DcLid = Value(scheme, ButtonsGroup, LidAction, true)
            };
            return Assess(data);
        } catch { return Unknown(); }
        finally { if (pointer != IntPtr.Zero) LocalFree(pointer); }
    }
    private static PowerAssessment Unknown() { return new PowerAssessment { Available = false, Risk = false, Summary = "电源配置读取失败", Detail = "无法确认自动睡眠设置。睡眠、休眠或关机时，手机将无法连接。", Fingerprint = "unknown" }; }
    private static string Duration(uint seconds) { return seconds % 60 == 0 ? (seconds / 60) + " 分钟" : seconds + " 秒"; }
    internal static PowerAssessment Assess(PowerConfiguration data) {
        var risks = new List<string>(); var lines = new List<string>(); bool complete = true;
        foreach (bool battery in data.HasBattery ? new[] { false, true } : new[] { false }) {
            string source = battery ? "电池" : "接电";
            uint? sleep = battery ? data.DcSleep : data.AcSleep;
            uint? hibernate = battery ? data.DcHibernate : data.AcHibernate;
            uint? lid = battery ? data.DcLid : data.AcLid;
            if (data.CanSleep) {
                if (!sleep.HasValue) complete = false;
                else if (sleep.Value > 0) risks.Add(source + "空闲 " + Duration(sleep.Value) + "后睡眠");
                lines.Add(source + "自动睡眠：" + (!sleep.HasValue ? "未能读取" : sleep.Value == 0 ? "从不" : Duration(sleep.Value)));
            }
            if (data.CanHibernate) {
                if (!hibernate.HasValue) complete = false;
                else if (hibernate.Value > 0) risks.Add(source + "空闲 " + Duration(hibernate.Value) + "后休眠");
                lines.Add(source + "自动休眠：" + (!hibernate.HasValue ? "未能读取" : hibernate.Value == 0 ? "从不" : Duration(hibernate.Value)));
            }
            if (data.HasLid) {
                if (!lid.HasValue || lid.Value > 3) { complete = false; lines.Add(source + "合盖操作：未能读取"); }
                else { string action = new[] { "不操作", "睡眠", "休眠", "关机" }[lid.Value]; lines.Add(source + "合盖操作：" + action); if (lid.Value > 0) risks.Add(source + "合盖设置为" + action); }
            }
        }
        if (data.ModernStandby) lines.Add("支持现代待机，息屏后的联网行为还受系统与驱动影响。");
        lines.Add("睡眠、休眠、关机或断电时，手机将无法连接；助手不会自动唤醒电脑或修改电源设置。");
        string summary = risks.Count > 0 ? risks[0] + (risks.Count > 1 ? "等 " + risks.Count + " 项风险" : "，手机会断开") : !complete ? "部分电源设置未能读取" : "未设置自动睡眠或休眠";
        return new PowerAssessment { Available = complete, Risk = risks.Count > 0, Summary = summary, Detail = String.Join("\r\n", lines), Fingerprint = (data.Scheme ?? "") + ":" + String.Join("|", risks) + ":" + complete };
    }
}
