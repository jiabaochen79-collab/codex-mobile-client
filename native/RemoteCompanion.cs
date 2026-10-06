using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Management;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("ChatGPT 远程助手")]
[assembly: System.Reflection.AssemblyProduct("ChatGPT 远程助手")]
[assembly: System.Reflection.AssemblyDescription("用于连接 Codex 桌面客户端的独立远程工具")]

internal static class Program {
    internal const string ProductName = "ChatGPT 远程助手";
    internal static readonly string HelperVersion = FileVersionInfo.GetVersionInfo(typeof(Program).Assembly.Location).ProductVersion;
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string title);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(uint processId);
    [DllImport("user32.dll")]
    internal static extern bool SetForegroundWindow(IntPtr window);
    [STAThread]
    private static int Main(string[] args) {
        try {
            if (args.Length > 0 && args[0] == "--version") { Console.Write(HelperVersion); return 0; }
            if (args.Length > 0 && args[0] == "--computer-id") {
                using (var key = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64).OpenSubKey(@"SOFTWARE\Microsoft\Cryptography")) {
                    var value = key == null ? "" : Convert.ToString(key.GetValue("MachineGuid")); Guid parsed;
                    if (!Guid.TryParse(value, out parsed)) return 1;
                    using (var sha = SHA256.Create()) Console.Write(BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes("codex-mobile:computer:v1:" + parsed.ToString("D").ToLowerInvariant()))).Replace("-", "").ToLowerInvariant());
                }
                return 0;
            }
            if (args.Length == 3 && args[0] == "--update-health" && Regex.IsMatch(args[1], @"^[a-f0-9-]{36}(-rollback)?$")) Environment.SetEnvironmentVariable("CODEX_MOBILE_UPDATE_HEALTH", args[1]);
            if (args.Length > 0 && (args[0] == "--protect" || args[0] == "--unprotect")) {
                string input;
                using (var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8)) input = reader.ReadToEnd();
                var data = args[0] == "--protect" ? Encoding.UTF8.GetBytes(input) : Convert.FromBase64String(input);
                var result = args[0] == "--protect" ? ProtectedData.Protect(data, null, DataProtectionScope.CurrentUser) : ProtectedData.Unprotect(data, null, DataProtectionScope.CurrentUser);
                using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) writer.Write(args[0] == "--protect" ? Convert.ToBase64String(result) : Encoding.UTF8.GetString(result)); return 0;
            }
            if (args.Length > 0 && args[0] == "--discover") { Discover(); return 0; }
            if (args.Length > 0 && args[0] == "--power-status") { using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) writer.Write(Json.Serialize(PowerSettings.Read())); return 0; }
            using (var showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\CodexMobileCompanion.Show"))
            using (var closeSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\CodexMobileCompanion.Exit"))
            using (var mutex = new Mutex(false, "Local\\CodexMobileCompanion")) {
                bool ownsMutex;
                try { ownsMutex = mutex.WaitOne(0); } catch (AbandonedMutexException) { ownsMutex = true; }
                if (!ownsMutex) {
                    uint processId;
                    var window = FindWindow(null, ProductName);
                    if (window == IntPtr.Zero) window = FindWindow(null, "远程伴侣");
                    if (window != IntPtr.Zero) {
                        GetWindowThreadProcessId(window, out processId);
                        using (var existing = Process.GetProcessById((int)processId)) {
                            if (existing.ProcessName == Process.GetCurrentProcess().ProcessName && existing.SessionId == Process.GetCurrentProcess().SessionId) AllowSetForegroundWindow(processId);
                        }
                    }
                    showSignal.Set(); return 0;
                }
                try { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new CompanionForm(showSignal, closeSignal)); }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        } catch (Exception e) {
            if (args.Length > 0) { Console.Error.WriteLine(e.GetType().Name + (args[0] == "--discover" ? ": " + e.Message : "")); return 1; }
            MessageBox.Show("助手未能启动：" + e.Message, ProductName, MessageBoxButtons.OK, MessageBoxIcon.Error); return 1;
        }
    }
    private static void Discover() {
        int session = Process.GetCurrentProcess().SessionId;
        string currentSid = WindowsIdentity.GetCurrent().User.Value;
        ManagementObject main = null;
        using (var query = new ManagementObjectSearcher("SELECT ProcessId, ExecutablePath, CommandLine, SessionId FROM Win32_Process WHERE Name='ChatGPT.exe' OR Name='Codex.exe'")) {
            foreach (ManagementObject p in query.Get()) {
                var file = Convert.ToString(p["ExecutablePath"]); var cmd = Convert.ToString(p["CommandLine"]);
                if (Convert.ToInt32(p["SessionId"]) != session || cmd.Contains("--type=") || !file.Contains("OpenAI.Codex_")) continue;
                using (var processObject = new ManagementObject("Win32_Process.Handle='" + Convert.ToString(p["ProcessId"]) + "'")) {
                    var owner = processObject.InvokeMethod("GetOwnerSid", null, null);
                    if (owner == null || Convert.ToString(owner["Sid"]) != currentSid) continue;
                }
                if (main != null) throw new InvalidOperationException("Multiple desktop instances"); main = p;
            }
        }
        if (main == null) { Console.Write(Program.Json.Serialize(new { version = (string)null, processId = 0, toolsPipe = (string)null, executablePath = (string)null, cliExecutablePath = (string)null })); return; }
        var pid = Convert.ToInt32(main["ProcessId"]); var executable = Convert.ToString(main["ExecutablePath"]);
        var version = Regex.Match(executable, @"OpenAI\.Codex_([0-9.]+)_").Groups[1].Value;
        var toolPipes = new List<string>();
        var toolOwnerProcessIds = new List<int> { pid };
        var cliExecutables = new List<string>();
        using (var query = new ManagementObjectSearcher("SELECT ProcessId, ExecutablePath, CommandLine, SessionId FROM Win32_Process WHERE ParentProcessId=" + pid + " AND Name='codex.exe'")) {
            foreach (ManagementObject p in query.Get()) {
                var childPid = Convert.ToInt32(p["ProcessId"]);
                var match = Regex.Match(Convert.ToString(p["CommandLine"]), @"codex-browser-use-[a-f0-9-]+");
                var cliPath = Convert.ToString(p["ExecutablePath"]);
                if (Convert.ToInt32(p["SessionId"]) != session || !File.Exists(cliPath) || !String.Equals(Path.GetFileName(cliPath), "codex.exe", StringComparison.OrdinalIgnoreCase)) continue;
                using (var processObject = new ManagementObject("Win32_Process.Handle='" + Convert.ToString(p["ProcessId"]) + "'")) {
                    var owner = processObject.InvokeMethod("GetOwnerSid", null, null);
                    if (owner == null || Convert.ToString(owner["Sid"]) != currentSid) continue;
                }
                toolOwnerProcessIds.Add(childPid);
                if (match.Success) toolPipes.Add(@"\\.\pipe\" + match.Value);
                cliExecutables.Add(cliPath);
            }
        }
        // Newer Codex builds publish a separate app-tool pipe, no longer a CLI argument.
        try { toolPipes.AddRange(Directory.GetFiles(@"\\.\pipe\", "codex-browser-use-*")); } catch (IOException) { }
        var pipe = DesktopToolsPipe.Find(toolOwnerProcessIds, toolPipes);
        var cliPaths = cliExecutables.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        Console.Write(Program.Json.Serialize(new { version = version, processId = pid, toolsPipe = pipe, executablePath = executable, cliExecutablePath = cliPaths.Length == 1 ? cliPaths[0] : null }));
    }
}

internal sealed class CompanionForm : Form {
    private readonly Label id = new Label();
    private readonly Label code = new Label();
    private readonly Label codeLabel = new Label();
    private readonly Label passwordPolicy = new Label();
    private readonly Label relayStatus = new Label();
    private readonly Label clientStatus = new Label();
    private readonly Label clientBadge = new Label();
    private readonly Label authorization = new Label();
    private readonly Label serverAddress = new Label();
    private readonly Label subscriptionStatus = new Label();
    private readonly Button subscriptionDetails = new Button();
    private readonly Label powerStatus = new Label();
    private readonly Button powerSettings = new Button();
    private readonly System.Windows.Forms.Timer powerTimer = new System.Windows.Forms.Timer();
    private PowerAssessment powerAssessment;
    private string lastPowerNotice;
    private DateTime lastPowerNoticeAt = DateTime.MinValue;
    private readonly Label error = new Label();
    private readonly CheckBox enabled = new CheckBox();
    private readonly Button reveal = new Button();
    private readonly Button rotate = new Button();
    private readonly Button refreshCode = new Button();
    private readonly Button passwordSettings = new Button();
    private readonly Button copyId = new Button();
    private readonly Button copyPassword = new Button();
    private readonly Button copyAll = new Button();
    private readonly Button openWeb = new Button();
    private readonly Button updateButton = new Button();
    private ToolStripMenuItem updateMenu;
    private ToolStripMenuItem helpUpdateMenu;
    private ToolStripMenuItem helpFeedbackMenu;
    private ToolStripMenuItem trayFeedbackMenu;
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly HttpClient http = new HttpClient();
    private readonly ToolTip tooltips = new ToolTip();
    private readonly Dictionary<string, Image> images = new Dictionary<string, Image>();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly System.Windows.Forms.Timer updateAnimationTimer = new System.Windows.Forms.Timer();
    private Image updateButtonImage;
    private int updateAnimationFrame;
    private Process agent;
    private Dictionary<string, object> state;
    private string token;
    private int port;
    private bool updating;
    private bool polling;
    private bool working;
    private bool visibleCode;
    private bool exiting;
    private readonly string root;
    private string agentError;
    private string actionError;
    private int actionRevision;
    private string lastConnectionFailure;
    private int agentFailures;
    private int failedPolls;
    private DateTime nextAgentStart;
    private DateTime agentReadyAt;
    private readonly EventWaitHandle showSignal;
    private readonly EventWaitHandle closeSignal;
    private RegisteredWaitHandle showRegistration;
    private RegisteredWaitHandle closeRegistration;

    internal CompanionForm(EventWaitHandle showSignal) : this(showSignal, null) { }
    internal CompanionForm(EventWaitHandle showSignal, EventWaitHandle closeSignal) {
        this.showSignal = showSignal;
        this.closeSignal = closeSignal;
        root = AppDomain.CurrentDomain.BaseDirectory;
        http.Timeout = TimeSpan.FromSeconds(12);
        Text = Program.ProductName; Font = new Font("Microsoft YaHei UI", 9.5f);
        AutoScaleDimensions = new SizeF(96, 96); AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(760, 642); MinimumSize = new Size(716, 652); MaximumSize = new Size(1160, 972);
        BackColor = Color.White; StartPosition = FormStartPosition.CenterScreen;
        var menu = new MenuStrip { Dock = DockStyle.Top, Margin = Padding.Empty };
        var help = new ToolStripMenuItem("帮助");
        helpUpdateMenu = new ToolStripMenuItem("检查更新", LoadImage("refresh"), async (s, e) => await CheckForUpdate());
        helpFeedbackMenu = new ToolStripMenuItem("问题反馈", LoadImage("feedback"), (s, e) => OpenPanel("feedback"));
        help.DropDownItems.Add(helpUpdateMenu); help.DropDownItems.Add(new ToolStripSeparator()); help.DropDownItems.Add(helpFeedbackMenu); menu.Items.Add(help); MainMenuStrip = menu;
        var iconFile = Path.Combine(root, "companion.ico"); if (File.Exists(iconFile)) Icon = new Icon(iconFile);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Margin = Padding.Empty };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 90)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 1)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 96)); Controls.Add(layout); Controls.Add(menu);
        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, Padding = new Padding(28, 18, 28, 14), Margin = Padding.Empty };
        header.RowCount = 1; header.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 58)); header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 154));
        header.Controls.Add(new PictureBox { Image = LoadImage("brand"), SizeMode = PictureBoxSizeMode.Zoom, Dock = DockStyle.Fill, Margin = new Padding(0, 4, 14, 6) }, 0, 0);
        var brand = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = Padding.Empty };
        brand.RowStyles.Add(new RowStyle(SizeType.Absolute, 34)); brand.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        brand.Controls.Add(TextLabel(Program.ProductName, 18, true), 0, 0); brand.Controls.Add(TextLabel("助手 v" + Program.HelperVersion, 9, false, true), 0, 1); header.Controls.Add(brand, 1, 0);
        FormatLabel(relayStatus); relayStatus.Text = "正在连接服务器"; relayStatus.TextAlign = ContentAlignment.MiddleRight; header.Controls.Add(relayStatus, 2, 0); layout.Controls.Add(header, 0, 0);
        layout.Controls.Add(new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty, BackColor = Color.FromArgb(229, 233, 237) }, 0, 1);

        var body = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 9, Padding = new Padding(28, 18, 28, 0), Margin = Padding.Empty };
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        foreach (int height in new[] { 40, 26, 60, 40, 54, 54, 54, 54 }) body.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        body.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(body, 0, 2);
        body.Controls.Add(TextLabel("本设备", 12, true), 0, 0);
        enabled.Text = "允许远程连接"; enabled.AutoSize = true; enabled.Anchor = AnchorStyles.Right; enabled.Margin = new Padding(0, 0, 0, 0); enabled.Enabled = false;
        enabled.CheckedChanged += async (s, e) => { if (!updating) await Action("/local/enabled", new { enabled = enabled.Checked }); }; body.Controls.Add(enabled, 1, 0);
        body.Controls.Add(TextLabel("本设备 ID", 9, false, true), 0, 1); FormatLabel(codeLabel, true); codeLabel.Text = "验证码"; codeLabel.Margin = new Padding(12, 0, 0, 0); body.Controls.Add(codeLabel, 1, 1);
        FormatLabel(id); id.Font = new Font("Segoe UI", 26); id.Text = "--- --- ---";
        ConfigureButton(copyId, "copy", "复制设备 ID", false); copyId.Click += (s, e) => Copy(Get("deviceId"));
        var idField = ValueField(id, new[] { copyId }); idField.Margin = new Padding(0, 0, 12, 0); body.Controls.Add(idField, 0, 2);
        FormatLabel(code); code.Font = new Font("Segoe UI", 20); code.Text = new String('\u2022', 8);
        ConfigureButton(reveal, "eye", "显示密码", false); reveal.Click += (s, e) => { visibleCode = !visibleCode; UpdateCredentials(); };
        ConfigureButton(copyPassword, "copy", "复制连接密码", false); copyPassword.Click += (s, e) => Copy(Get("code"));
        var passwordField = ValueField(code, new[] { reveal, copyPassword }); passwordField.Margin = new Padding(12, 0, 0, 0); body.Controls.Add(passwordField, 1, 2);
        var policy = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, Margin = new Padding(12, 4, 0, 0) };
        policy.RowCount = 1; policy.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        policy.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); policy.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36)); policy.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36));
        FormatLabel(passwordPolicy, true); passwordPolicy.Font = new Font(Font.FontFamily, 8.5f); policy.Controls.Add(passwordPolicy, 0, 0);
        ConfigureButton(refreshCode, "refresh", "更换验证码", false); tooltips.SetToolTip(refreshCode, "更换验证码并撤销现有手机授权"); refreshCode.Click += async (s, e) => await Rotate(true); policy.Controls.Add(refreshCode, 1, 0);
        ConfigureButton(passwordSettings, "settings", "密码设置", false); passwordSettings.Enabled = false; passwordSettings.Click += async (s, e) => await EditPassword(); policy.Controls.Add(passwordSettings, 2, 0); body.Controls.Add(policy, 1, 3);
        FormatLabel(subscriptionStatus, true); ConfigureButton(subscriptionDetails, "ticket", "订阅与权益", true);
        subscriptionDetails.Click += (s, e) => { if (token != null) Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port + "/?panel=subscription#token=" + Uri.EscapeDataString(token)) { UseShellExecute = true }); };
        var subscriptionRow = StatusRow("ticket", "订阅", subscriptionStatus, subscriptionDetails); body.Controls.Add(subscriptionRow, 0, 4); body.SetColumnSpan(subscriptionRow, 2);
        FormatLabel(clientStatus, true); FormatLabel(clientBadge); clientBadge.TextAlign = ContentAlignment.MiddleRight;
        FormatLabel(powerStatus, true); ConfigureButton(powerSettings, "settings", "电源设置", true);
        powerSettings.Click += (s, e) => { try { Process.Start(new ProcessStartInfo("control.exe", "/name Microsoft.PowerOptions") { UseShellExecute = true }); } catch { error.Text = "无法打开 Windows 电源设置。"; } };
        var powerRow = StatusRow("moon", "电源状态", powerStatus, powerSettings); body.Controls.Add(powerRow, 0, 5); body.SetColumnSpan(powerRow, 2);
        var clientRow = StatusRow("monitor", "Codex 客户端", clientStatus, clientBadge); body.Controls.Add(clientRow, 0, 6); body.SetColumnSpan(clientRow, 2);
        FormatLabel(authorization, true); ConfigureButton(rotate, "unplug", "撤销全部授权", true); rotate.ForeColor = Color.FromArgb(169, 61, 65); rotate.FlatAppearance.MouseOverBackColor = Color.FromArgb(254, 241, 241); rotate.Click += async (s, e) => await Rotate(false);
        var authorizationRow = StatusRow("shield", "手机授权", authorization, rotate); body.Controls.Add(authorizationRow, 0, 7); body.SetColumnSpan(authorizationRow, 2);

        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 3, Padding = new Padding(28, 4, 28, 0), Margin = Padding.Empty, BackColor = Color.FromArgb(247, 249, 250) };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 40)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 332)); footer.RowStyles.Add(new RowStyle(SizeType.Absolute, 44)); footer.RowStyles.Add(new RowStyle(SizeType.Absolute, 24)); footer.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.Controls.Add(footer, 0, 3);
        footer.Controls.Add(TextLabel("手机连接", 10, true), 0, 0);
        var maintenance = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty };
        ConfigureButton(updateButton, "download", "新版本已就绪，点击安装", false); updateButton.Visible = false; updateButton.Click += async (s, e) => await InstallUpdate(); maintenance.Controls.Add(updateButton); footer.Controls.Add(maintenance, 1, 0);
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty, Padding = new Padding(10, 0, 0, 0) };
        ConfigureButton(copyAll, "copy-white", "复制连接信息", true); copyAll.Size = new Size(156, 38); copyAll.Margin = new Padding(0, 3, 10, 0); copyAll.BackColor = Color.FromArgb(39, 100, 208); copyAll.ForeColor = Color.White; copyAll.FlatAppearance.BorderSize = 0; copyAll.FlatAppearance.MouseOverBackColor = Color.FromArgb(30, 82, 176);
        copyAll.Click += (s, e) => { if (state != null) Copy(Get("url") + "\r\n设备 ID：" + id.Text + "\r\n连接密码：" + Get("code")); }; actions.Controls.Add(copyAll);
        ConfigureButton(openWeb, "external", "打开手机网页", true); openWeb.Size = new Size(156, 38); openWeb.Margin = new Padding(0, 3, 0, 0);
        openWeb.Click += (s, e) => { var url = Get("url"); if (url.StartsWith("https://") || url.StartsWith("http://127.0.0.1:")) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }; actions.Controls.Add(openWeb);
        footer.Controls.Add(actions, 2, 0);
        FormatLabel(serverAddress, true); serverAddress.Font = new Font("Segoe UI", 9); footer.Controls.Add(serverAddress, 0, 1); footer.SetColumnSpan(serverAddress, 3);
        FormatLabel(error); error.ForeColor = Color.FromArgb(169, 61, 65); error.Font = new Font(Font.FontFamily, 8.5f); footer.Controls.Add(error, 0, 2); footer.SetColumnSpan(error, 3);
        tray.Icon = Icon; tray.Text = Program.ProductName; tray.Visible = true; tray.DoubleClick += (s, e) => ShowWindow();
        var trayMenu = new ContextMenuStrip(); trayMenu.Items.Add("打开", null, (s, e) => ShowWindow()); updateMenu = new ToolStripMenuItem("检查更新", LoadImage("refresh"), async (s, e) => await CheckForUpdate()); trayMenu.Items.Add(updateMenu); trayFeedbackMenu = new ToolStripMenuItem("问题反馈", LoadImage("feedback"), (s, e) => OpenPanel("feedback")); trayMenu.Items.Add(trayFeedbackMenu); trayMenu.Items.Add("退出助手", null, (s, e) => { exiting = true; Close(); }); tray.ContextMenuStrip = trayMenu;
        FormClosing += (s, e) => { if (!exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
        FormClosed += (s, e) => { exiting = true; if (showRegistration != null) showRegistration.Unregister(null); if (closeRegistration != null) closeRegistration.Unregister(null); timer.Stop(); updateAnimationTimer.Stop(); tray.Visible = false; tray.Dispose(); StopAgent(); http.Dispose(); tooltips.Dispose(); if (updateButtonImage != null) updateButtonImage.Dispose(); foreach (var image in images.Values) image.Dispose(); };
        Shown += async (s, e) => { RefreshPowerSettings(); timer.Start(); await Poll(); };
        Activated += (s, e) => RefreshPowerSettings();
        powerTimer.Interval = 60000; powerTimer.Tick += (s, e) => RefreshPowerSettings(); powerTimer.Start();
        FormClosed += (s, e) => { powerTimer.Stop(); powerTimer.Dispose(); };
        timer.Interval = 2500; timer.Tick += async (s, e) => await Poll();
        updateAnimationTimer.Interval = 180; updateAnimationTimer.Tick += (s, e) => AnimateUpdateButton();
        SetControlsEnabled();
    }
    private Label LabelAt(string text, int x, int y, int w, int h, int size, bool bold) { return new Label { Text = text, Bounds = new Rectangle(x, y, w, h), Font = new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular), ForeColor = Color.FromArgb(31, 43, 50) }; }
    private void RefreshPowerSettings() { if (IsDisposed || Disposing) return; powerAssessment = PowerSettings.Read(); RenderPowerSettings(); }
    private void RenderPowerSettings() {
        if (powerAssessment == null) return;
        powerStatus.Text = powerAssessment.Summary; powerStatus.ForeColor = powerAssessment.Risk || !powerAssessment.Available ? Color.FromArgb(158, 101, 30) : Color.FromArgb(116, 126, 137);
        tooltips.SetToolTip(powerStatus, powerAssessment.Detail);
        if (!powerAssessment.Risk) { lastPowerNotice = null; return; }
        if (enabled.Checked && tray.Visible && lastPowerNotice != powerAssessment.Fingerprint && DateTime.UtcNow - lastPowerNoticeAt > TimeSpan.FromMinutes(10)) {
            lastPowerNotice = powerAssessment.Fingerprint; lastPowerNoticeAt = DateTime.UtcNow;
            tray.ShowBalloonTip(6000, "电源设置可能影响远程连接", powerAssessment.Summary + "。可在助手中打开电源设置检查。", ToolTipIcon.Warning);
        }
    }
    protected override void WndProc(ref Message message) {
        base.WndProc(ref message);
        if (message.Msg == 0x218 && IsHandleCreated && !Disposing && (message.WParam.ToInt32() == 0xA || message.WParam.ToInt32() == 0x12)) RefreshPowerSettings();
    }
    private static void FormatLabel(Label label, bool muted = false) { label.Dock = DockStyle.Fill; label.Margin = Padding.Empty; label.TextAlign = ContentAlignment.MiddleLeft; label.AutoEllipsis = true; label.ForeColor = muted ? Color.FromArgb(116, 126, 137) : Color.FromArgb(33, 40, 48); }
    private Label TextLabel(string text, float size, bool bold = false, bool muted = false) { var label = new Label { Text = text, Font = new Font(Font.FontFamily, size, bold ? FontStyle.Bold : FontStyle.Regular) }; FormatLabel(label, muted); return label; }
    private static void StyleButton(Button b) { b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderColor = Color.FromArgb(219, 225, 231); b.FlatAppearance.MouseOverBackColor = Color.FromArgb(240, 244, 248); b.BackColor = Color.White; b.ForeColor = Color.FromArgb(68, 81, 97); b.Cursor = Cursors.Hand; }
    private Image LoadImage(string name) {
        string file = Path.Combine(root, "icons", name + ".png");
        if (!images.ContainsKey(name) && File.Exists(file)) images[name] = Image.FromFile(file);
        return images.ContainsKey(name) ? images[name] : null;
    }
    private void SetIcon(Button button, string name, string label, bool withText = false) {
        button.Image = LoadImage(name); button.Text = withText || button.Image == null ? label : "";
        button.AccessibleName = label; tooltips.SetToolTip(button, label);
    }
    private void ConfigureButton(Button button, string icon, string label, bool withText) {
        StyleButton(button); SetIcon(button, icon, label, withText); button.Size = new Size(withText ? 156 : 34, 34); button.Anchor = AnchorStyles.Right; button.Margin = new Padding(1, 0, 1, 0);
        button.TextImageRelation = TextImageRelation.ImageBeforeText; button.ImageAlign = withText ? ContentAlignment.MiddleLeft : ContentAlignment.MiddleCenter;
        if (withText) button.Padding = new Padding(8, 0, 6, 0); else { button.FlatAppearance.BorderSize = 0; button.BackColor = Color.Transparent; }
    }
    private TableLayoutPanel ValueField(Label value, Button[] buttons) {
        var field = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = buttons.Length + 1, Padding = new Padding(12, 0, 6, 0), BackColor = Color.FromArgb(244, 246, 248) };
        field.RowCount = 1; field.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        field.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); field.Controls.Add(value, 0, 0);
        for (int i = 0; i < buttons.Length; i++) { field.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36)); field.Controls.Add(buttons[i], i + 1, 0); }
        return field;
    }
    private TableLayoutPanel StatusRow(string icon, string title, Label detail, Control action) {
        var row = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, Margin = Padding.Empty, Padding = new Padding(0, 5, 0, 5) };
        row.RowCount = 1; row.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36)); row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 160));
        row.Controls.Add(new PictureBox { Image = LoadImage(icon), SizeMode = PictureBoxSizeMode.CenterImage, Dock = DockStyle.Fill, Margin = new Padding(0, 0, 12, 0) }, 0, 0);
        var labels = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = Padding.Empty };
        labels.RowStyles.Add(new RowStyle(SizeType.Percent, 50)); labels.RowStyles.Add(new RowStyle(SizeType.Percent, 50)); labels.Controls.Add(TextLabel(title, 9.5f), 0, 0); detail.Font = new Font(Font.FontFamily, 8.5f); labels.Controls.Add(detail, 0, 1); row.Controls.Add(labels, 1, 0); row.Controls.Add(action, 2, 0); return row;
    }
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        if (showRegistration != null) return;
        // AutoReset retains an early second-launch signal until the UI handle exists.
        showRegistration = ThreadPool.RegisterWaitForSingleObject(showSignal, (state, timedOut) => {
            try { if (!IsDisposed && !Disposing) BeginInvoke((Action)ShowWindow); }
            catch (InvalidOperationException) { }
        }, null, Timeout.Infinite, false);
        if (closeSignal != null) closeRegistration = ThreadPool.RegisterWaitForSingleObject(closeSignal, (state, timedOut) => {
            try { if (!IsDisposed && !Disposing) BeginInvoke((Action)ExitForInstall); }
            catch (InvalidOperationException) { }
        }, null, Timeout.Infinite, false);
    }
    private void ShowWindow() { Show(); if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; BringToFront(); Activate(); Program.SetForegroundWindow(Handle); }
    private void ExitForInstall() { exiting = true; Close(); }
    private void OpenPanel(string panel) { if (token != null) Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port + "/?panel=" + panel + "#token=" + Uri.EscapeDataString(token)) { UseShellExecute = true }); }
    private async Task CheckForUpdate() {
        if (token == null || working) return;
        var current = state != null && state.ContainsKey("update") ? state["update"] as Dictionary<string, object> : null;
        var phase = current != null && current.ContainsKey("phase") ? Convert.ToString(current["phase"]) : "idle";
        if (phase == "checking" || phase == "downloading" || phase == "installing") { error.Text = UpdateStatusText(current); error.ForeColor = Color.FromArgb(116, 126, 137); return; }
        error.Text = "正在检查更新，请稍候..."; error.ForeColor = Color.FromArgb(116, 126, 137);
        await Action("/local/update/check", new { });
    }
    private async Task InstallUpdate() {
        if (working || state == null) return;
        var update = state.ContainsKey("update") ? state["update"] as Dictionary<string, object> : null;
        if (update == null || Convert.ToString(update["phase"]) != "ready") return;
        var version = Convert.ToString(update.ContainsKey("version") ? update["version"] : "");
        var detail = String.IsNullOrEmpty(version) ? "助手将短暂退出并重启，电脑上的 Codex 任务不会停止。" : "将安装助手 v" + version + " 并重启助手，电脑上的 Codex 任务不会停止。";
        if (MessageBox.Show(this, detail, "安装助手更新？", MessageBoxButtons.OKCancel, MessageBoxIcon.Information, MessageBoxDefaultButton.Button2) != DialogResult.OK) return;
        await Action("/local/update/install", new { });
    }
    private string Get(string key) { return state != null && state.ContainsKey(key) ? Convert.ToString(state[key]) : ""; }
    private void Copy(string text) { if (!String.IsNullOrWhiteSpace(text)) { try { Clipboard.SetText(text); error.Text = "已复制"; } catch { error.Text = "剪贴板暂时不可用。"; } } }
    private void SetUpdateButtonIcon(bool spinning, string label) {
        if (updateButtonImage != null) { updateButton.Image = null; updateButtonImage.Dispose(); updateButtonImage = null; }
        if (spinning) {
            var source = LoadImage("refresh");
            if (source != null) { updateButtonImage = new Bitmap(source); var rotations = new[] { RotateFlipType.RotateNoneFlipNone, RotateFlipType.Rotate90FlipNone, RotateFlipType.Rotate180FlipNone, RotateFlipType.Rotate270FlipNone }; updateButtonImage.RotateFlip(rotations[updateAnimationFrame % rotations.Length]); updateButton.Image = updateButtonImage; }
        } else updateButton.Image = LoadImage("download");
        updateButton.Text = updateButton.Image == null ? label : ""; updateButton.AccessibleName = label; tooltips.SetToolTip(updateButton, label);
    }
    private void AnimateUpdateButton() {
        var update = state == null || !state.ContainsKey("update") ? null : state["update"] as Dictionary<string, object>;
        if (update == null || Convert.ToString(update["phase"]) != "downloading") { updateAnimationTimer.Stop(); return; }
        updateAnimationFrame = (updateAnimationFrame + 1) % 4;
        var progress = update.ContainsKey("progress") ? Convert.ToInt32(update["progress"]) : 0;
        SetUpdateButtonIcon(true, "正在下载助手更新 " + progress + "%");
    }
    private string UpdateStatusText(Dictionary<string, object> update) {
        if (update == null) return "";
        var phase = update.ContainsKey("phase") ? Convert.ToString(update["phase"]) : "idle";
        var message = update.ContainsKey("message") ? Convert.ToString(update["message"]) : "";
        var version = update.ContainsKey("version") ? Convert.ToString(update["version"]) : "";
        if (phase == "checking") return "正在检查更新，请稍候...";
        if (phase == "available") return String.IsNullOrEmpty(version) ? "发现新版本，准备下载..." : "发现助手 v" + version + "，准备下载...";
        if (phase == "downloading") return "正在下载助手更新 " + (update.ContainsKey("progress") ? Convert.ToInt32(update["progress"]) : 0) + "%";
        if (phase == "ready") return String.IsNullOrEmpty(version) ? "新版本已下载完成，点击下载图标安装。" : "助手 v" + version + " 已下载完成，点击下载图标安装。";
        if (phase == "installing") return "正在安装助手更新，助手即将重启...";
        if (phase == "error") return String.IsNullOrEmpty(message) ? "更新失败，请稍后重试。" : message;
        return message;
    }
    private void UpdateCredentials() {
        id.Text = Regex.Replace(Get("deviceId"), @"(\d{3})(?=\d)", "$1 "); code.Text = visibleCode ? Get("code") : new String('\u2022', 8);
        int size = Get("passwordMode") == "custom" && visibleCode ? 14 : 20;
        string family = visibleCode ? "Consolas" : "Segoe UI";
        if (code.Font.Size != size || code.Font.FontFamily.Name != family) { var old = code.Font; code.Font = new Font(family, size); old.Dispose(); }
        SetIcon(reveal, visibleCode ? "eye-off" : "eye", visibleCode ? "隐藏密码" : "显示密码");
    }
    private async Task Rotate(bool changingCode) {
        if (state == null || working) return;
        string title = changingCode ? "更换验证码？" : "撤销全部授权？";
        string detail = "所有已授权的手机和浏览器都需要重新连接。\r\n" + (Get("passwordMode") == "custom" ? "自定义固定密码保持不变。" : "当前验证码将同时更换。");
        if (MessageBox.Show(this, detail, title, MessageBoxButtons.OKCancel, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.OK) await Action("/local/rotate", new { });
    }
    private async Task StartAgent() {
        try {
            string node = Path.Combine(root, "node.exe"), entry = Path.Combine(root, "dist", "agent.mjs");
            if (!File.Exists(node) || !File.Exists(entry)) throw new FileNotFoundException("请使用包含 node.exe 和 dist 的完整发行包。");
            var start = new ProcessStartInfo(node, "\"" + entry + "\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = root };
            start.EnvironmentVariables["NATIVE_HOST"] = "1"; start.EnvironmentVariables["APP_ROOT"] = root; start.EnvironmentVariables["NATIVE_EXE"] = Application.ExecutablePath;
            start.EnvironmentVariables["USERPROFILE"] = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            start.EnvironmentVariables["AGENT_DATA_DIR"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexMobile");
            agentError = null;
            agent = Process.Start(start); agent.ErrorDataReceived += (s, e) => { if (e.Data != null && !e.Data.Contains("ExperimentalWarning") && !e.Data.Contains("trace-warnings")) agentError = "连接进程异常，请检查发行包和服务器配置。"; }; agent.BeginErrorReadLine();
            var readyTask = agent.StandardOutput.ReadLineAsync(); if (await Task.WhenAny(readyTask, Task.Delay(15000)) != readyTask) throw new TimeoutException("连接进程启动超时。");
            if (exiting || IsDisposed) { StopAgent(); return; }
            var ready = JsonObject(await readyTask); port = Convert.ToInt32(ready["port"]); token = Convert.ToString(ready["token"]);
            if (port < 1 || port > 65535 || String.IsNullOrEmpty(token)) throw new InvalidDataException("连接进程启动信息无效。");
            http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            agentReadyAt = DateTime.UtcNow; failedPolls = 0; LogAgent("started", null);
        } catch (Exception e) { ScheduleAgentRecovery(e.GetType().Name); }
    }
    private void StopAgent() {
        var process = agent; agent = null; token = null;
        if (process == null) return;
        try { if (!process.HasExited) { process.StandardInput.WriteLine("stop"); process.StandardInput.Close(); if (!process.WaitForExit(1000)) { process.Kill(); process.WaitForExit(1000); } } }
        catch { try { if (!process.HasExited) process.Kill(); } catch {} }
        finally { process.Dispose(); }
    }
    private void LogAgent(string kind, string detail) {
        try {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexMobile", "logs"); Directory.CreateDirectory(directory);
            var file = Path.Combine(directory, "helper.log");
            if (File.Exists(file) && new FileInfo(file).Length > 1024 * 1024) { var previous = file + ".1"; if (File.Exists(previous)) File.Delete(previous); File.Move(file, previous); }
            File.AppendAllText(file, Program.Json.Serialize(new { at = DateTime.UtcNow.ToString("o"), kind = kind, detail = detail, attempts = agentFailures }) + Environment.NewLine, Encoding.UTF8);
        } catch { }
    }
    private void ScheduleAgentRecovery(string cause) {
        LogAgent("unavailable", cause); StopAgent(); state = null;
        if (exiting || IsDisposed) return;
        agentFailures++; nextAgentStart = DateTime.UtcNow.AddSeconds(agentFailures > 5 ? 300 : Math.Min(60, Math.Pow(2, agentFailures)));
        error.Text = "连接进程已中断，将自动恢复。电脑上的 Codex 任务不受影响。";
        relayStatus.Text = "连接进程恢复中"; relayStatus.ForeColor = Color.FromArgb(146, 106, 48);
        clientBadge.Text = "待恢复"; authorization.Text = "授权状态待同步"; UpdateCredentials(); SetControlsEnabled();
    }
    private static Dictionary<string, object> JsonObject(string text) { return Program.Json.Deserialize<Dictionary<string, object>>(text); }
    private async Task Poll() {
        if (polling || working || exiting || IsDisposed) return; polling = true;
        int revision = actionRevision;
        try {
            if (agent != null && agent.HasExited) ScheduleAgentRecovery("exit:" + agent.ExitCode);
            if (agent == null && DateTime.UtcNow >= nextAgentStart) await StartAgent();
            if (token == null || exiting || IsDisposed) return;
            var next = JsonObject(await http.GetStringAsync("http://127.0.0.1:" + port + "/local/state"));
            if (exiting || IsDisposed || revision != actionRevision) return;
            state = next; failedPolls = 0;
            if (DateTime.UtcNow - agentReadyAt > TimeSpan.FromMinutes(5)) agentFailures = 0;
            Render();
        }
        catch { if (!exiting && !IsDisposed && revision == actionRevision) { error.Text = actionError ?? agentError ?? "连接进程未响应，正在重试。"; if (++failedPolls >= 3) ScheduleAgentRecovery("health-timeout"); } }
        finally { polling = false; }
    }
    private void Render() {
        var update = state.ContainsKey("update") ? state["update"] as Dictionary<string, object> : null;
        string updatePhase = update == null ? "idle" : Convert.ToString(update["phase"]);
        bool updateReady = updatePhase == "ready", updateDownloading = updatePhase == "downloading";
        int updateProgress = update != null && update.ContainsKey("progress") ? Convert.ToInt32(update["progress"]) : 0;
        string updateLabel = updateReady ? "新版本已就绪，点击安装" : "正在下载助手更新 " + updateProgress + "%";
        updateButton.Visible = updateReady || updateDownloading; updateButton.Enabled = updateReady && !working; updateButton.BackColor = updateReady ? Color.FromArgb(220, 242, 232) : Color.Transparent;
        if (updateDownloading) { updateAnimationTimer.Start(); SetUpdateButtonIcon(true, updateLabel); }
        else { updateAnimationTimer.Stop(); SetUpdateButtonIcon(false, updateLabel); }
        var updateMenuText = updatePhase == "checking" ? "正在检查更新..." : updateDownloading ? "正在下载更新 " + updateProgress + "%" : updateReady ? "更新已就绪" : "检查更新";
        if (updateMenu != null) { updateMenu.Text = updateMenuText; updateMenu.Enabled = token != null && !working && updatePhase != "checking" && updatePhase != "downloading" && updatePhase != "installing"; }
        if (helpUpdateMenu != null) { helpUpdateMenu.Text = updateMenuText; helpUpdateMenu.Enabled = token != null && !working && updatePhase != "checking" && updatePhase != "downloading" && updatePhase != "installing"; }
        bool unreadFeedback = state.ContainsKey("feedbackUnread") && Convert.ToInt32(state["feedbackUnread"]) > 0;
        var feedbackText = unreadFeedback ? "问题反馈（有新回复）" : "问题反馈";
        if (helpFeedbackMenu != null) { helpFeedbackMenu.Text = feedbackText; helpFeedbackMenu.Enabled = token != null; }
        if (trayFeedbackMenu != null) { trayFeedbackMenu.Text = feedbackText; trayFeedbackMenu.Enabled = token != null; }
        updating = true; enabled.Checked = Convert.ToBoolean(state["enabled"]); updating = false; UpdateCredentials();
        bool custom = Get("passwordMode") == "custom";
        codeLabel.Text = custom ? "固定密码" : "验证码";
        passwordPolicy.Text = custom ? "自定义固定密码" : "每次成功连接后自动换码";
        refreshCode.Visible = !custom;
        relayStatus.Text = Get("connection") == "online" ? "服务器已连接" : Get("connection") == "connecting" ? "正在连接服务器" : "服务器未连接";
        relayStatus.ForeColor = Get("connection") == "online" ? Color.FromArgb(35, 130, 93) : Color.FromArgb(146, 106, 48);
        var connectionError = state.ContainsKey("connectionError") ? state["connectionError"] as Dictionary<string, object> : null;
        string failure = connectionError == null ? "" : Convert.ToString(connectionError["stage"]) + "/" + Convert.ToString(connectionError["code"]);
        if (failure != lastConnectionFailure) { if (!String.IsNullOrEmpty(failure)) LogAgent("server-connection", failure); lastConnectionFailure = failure; }
        error.Text = actionError ?? (connectionError == null ? UpdateStatusText(update) : Convert.ToString(connectionError["message"]) + " [" + failure + "]");
        error.ForeColor = actionError == null && connectionError == null && updatePhase != "error" ? Color.FromArgb(116, 126, 137) : Color.FromArgb(169, 61, 65);
        tooltips.SetToolTip(relayStatus, error.Text); tooltips.SetToolTip(error, error.Text);
        var client = state["client"] as Dictionary<string, object>;
        bool available = client != null && Convert.ToBoolean(client["available"]);
        string clientVersion = client == null ? "" : Convert.ToString(client["version"]), clientReason = client == null ? "" : Convert.ToString(client["reason"]);
        clientStatus.Text = client == null ? "正在检查" : (String.IsNullOrEmpty(clientVersion) ? "" : "Codex " + clientVersion + (String.IsNullOrEmpty(clientReason) ? "" : "  ")) + clientReason;
        tooltips.SetToolTip(clientStatus, clientStatus.Text);
        clientBadge.Text = available ? String.IsNullOrEmpty(clientReason) ? "就绪" : "部分兼容" : "未就绪"; clientBadge.ForeColor = available && String.IsNullOrEmpty(clientReason) ? Color.FromArgb(35, 130, 93) : Color.FromArgb(146, 106, 48);
        authorization.Text = Get("authorizedCount") + " 个有效授权"; serverAddress.Text = Get("url");
        var subscription = state.ContainsKey("subscription") ? state["subscription"] as Dictionary<string, object> : null;
        string subscriptionState = subscription != null && subscription.ContainsKey("status") ? Convert.ToString(subscription["status"]) : "";
        bool banned = subscription != null && subscription.ContainsKey("disabled") && Convert.ToBoolean(subscription["disabled"]);
        subscriptionStatus.Text = banned ? "设备已被封禁" : subscriptionState == "free" ? "免费试运行" : subscriptionState == "trial" ? "邀请试用中" : subscriptionState == "active" ? "订阅有效" : subscriptionState == "expired" ? "订阅已到期" : subscriptionState == "unlicensed" ? "未开通订阅" : "订阅状态待同步";
        if (subscription != null && subscription.ContainsKey("expiresAt") && subscription["expiresAt"] != null) subscriptionStatus.Text += "  " + new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Convert.ToDouble(subscription["expiresAt"])).ToLocalTime().ToString("yyyy-MM-dd");
        SetControlsEnabled();
        RenderPowerSettings();
    }
    private void SetControlsEnabled() {
        bool ready = state != null && token != null && !working;
        enabled.Enabled = ready; passwordSettings.Enabled = ready; refreshCode.Enabled = ready;
        rotate.Enabled = ready && state.ContainsKey("authorizedCount") && Convert.ToInt32(state["authorizedCount"]) > 0;
        var update = state != null && state.ContainsKey("update") ? state["update"] as Dictionary<string, object> : null;
        var updatePhase = update != null && update.ContainsKey("phase") ? Convert.ToString(update["phase"]) : "idle";
        updateButton.Enabled = ready && updatePhase == "ready";
        var updateBusy = updatePhase == "checking" || updatePhase == "downloading" || updatePhase == "installing";
        if (updateMenu != null) updateMenu.Enabled = token != null && !working && !updateBusy;
        if (helpUpdateMenu != null) helpUpdateMenu.Enabled = token != null && !working && !updateBusy;
        if (helpFeedbackMenu != null) helpFeedbackMenu.Enabled = token != null;
        if (trayFeedbackMenu != null) trayFeedbackMenu.Enabled = token != null;
        copyId.Enabled = copyPassword.Enabled = reveal.Enabled = state != null && !String.IsNullOrEmpty(Get("deviceId"));
        copyAll.Enabled = openWeb.Enabled = state != null && !String.IsNullOrEmpty(Get("url"));
        subscriptionDetails.Enabled = state != null && token != null;
    }
    private Task EditPassword() {
        using (var dialog = new Form { Text = "密码设置", ClientSize = new Size(440, 292), Font = Font, StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, ShowInTaskbar = false }) {
            var automatic = new RadioButton { Text = "每次成功连接后自动换码（默认）", Bounds = new Rectangle(22, 22, 396, 30), Checked = Get("passwordMode") != "custom" };
            var custom = new RadioButton { Text = "自定义固定密码（8 至 64 位）", Bounds = new Rectangle(22, 61, 396, 30), Checked = Get("passwordMode") == "custom" };
            var password = new TextBox { Bounds = new Rectangle(42, 104, 370, 30), UseSystemPasswordChar = true, MaxLength = 64, Text = custom.Checked ? Get("code") : "", Enabled = custom.Checked, AccessibleName = "自定义密码，8 至 64 位" };
            var show = new CheckBox { Text = "显示密码", Bounds = new Rectangle(42, 146, 150, 28), Enabled = custom.Checked };
            var length = LabelAt(password.Text.Length + " / 64", 312, 146, 100, 28, 9, false); length.TextAlign = ContentAlignment.MiddleRight;
            password.TextChanged += (s, e) => { length.Text = password.Text.Length + " / 64"; };
            var validation = LabelAt("", 22, 185, 396, 34, 9, false); validation.ForeColor = Color.FromArgb(159, 76, 46);
            var save = new Button { Text = "保存", Bounds = new Rectangle(318, 236, 100, 34) }; StyleButton(save);
            var cancel = new Button { Text = "取消", Bounds = new Rectangle(204, 236, 100, 34), DialogResult = DialogResult.Cancel }; StyleButton(cancel);
            custom.CheckedChanged += (s, e) => { password.Enabled = custom.Checked; show.Enabled = custom.Checked; };
            show.CheckedChanged += (s, e) => { password.UseSystemPasswordChar = !show.Checked; };
            bool saving = false;
            dialog.FormClosing += (s, e) => { if (saving) e.Cancel = true; };
            save.Click += async (s, e) => {
                if (saving || working || token == null) return;
                if (custom.Checked && (password.Text.Length < 8 || password.Text.Length > 64 || String.IsNullOrWhiteSpace(password.Text))) { validation.Text = "密码需要 8 至 64 位。"; password.Focus(); return; }
                saving = true; save.Enabled = cancel.Enabled = automatic.Enabled = custom.Enabled = password.Enabled = show.Enabled = false;
                object value = custom.Checked ? (object)new { mode = "custom", password = password.Text } : new { mode = "automatic" };
                await Action("/local/password", value);
                saving = false;
                if (actionError == null) { dialog.DialogResult = DialogResult.OK; return; }
                validation.Text = actionError;
                save.Enabled = cancel.Enabled = automatic.Enabled = custom.Enabled = true; password.Enabled = show.Enabled = custom.Checked;
            };
            dialog.Controls.AddRange(new Control[] { automatic, custom, password, show, length, validation, save, cancel }); dialog.AcceptButton = save; dialog.CancelButton = cancel;
            dialog.ShowDialog(this);
        }
        return Task.FromResult(0);
    }
    private async Task Action(string url, object body) {
        if (token == null || working) return; working = true; actionRevision++; actionError = null; SetControlsEnabled();
        try {
            using (var result = await http.PostAsync("http://127.0.0.1:" + port + url, new StringContent(Program.Json.Serialize(body), Encoding.UTF8, "application/json"))) {
                var response = await result.Content.ReadAsStringAsync();
                if (!result.IsSuccessStatusCode) {
                    var failure = JsonObject(response); var detail = failure.ContainsKey("error") ? failure["error"] as Dictionary<string, object> : null;
                    actionError = detail != null && detail.ContainsKey("message") ? Convert.ToString(detail["message"]) : "操作未完成，请稍后重试。";
                    error.Text = actionError; error.ForeColor = Color.FromArgb(169, 61, 65); return;
                }
                if (url == "/local/update/install") { error.Text = "更新已开始，助手将重启。"; return; }
                if (ApplyActionResponse(url, response)) { error.Text = ""; Render(); }
            }
        }
        catch { actionError = "未收到操作确认，请先核对当前状态，再重试。"; error.Text = actionError; error.ForeColor = Color.FromArgb(169, 61, 65); }
        finally { working = false; SetControlsEnabled(); }
    }
    private bool ApplyActionResponse(string url, string response) {
        var next = JsonObject(response);
        if (url.StartsWith("/local/update/", StringComparison.Ordinal)) {
            if (state == null) return false;
            state["update"] = next;
        } else state = next;
        return true;
    }
}
