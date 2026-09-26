using System;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class NativeUiChecks {
    private static readonly BindingFlags Hidden = BindingFlags.Instance | BindingFlags.NonPublic;
    private static object Field(Form form, string name) { return form.GetType().GetField(name, Hidden).GetValue(form); }
    private static void Set(Form form, string name, object value) { form.GetType().GetField(name, Hidden).SetValue(form, value); }
    private static IEnumerable<Control> Children(Control parent) { foreach (Control child in parent.Controls) { yield return child; foreach (var descendant in Children(child)) yield return descendant; } }
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    [STAThread]
    private static int Main(string[] args) {
        try {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            var assembly = Assembly.LoadFrom(args[0]); var type = assembly.GetType("CompanionForm");
            var version = FileVersionInfo.GetVersionInfo(args[0]);
            Check(version.ProductVersion == args[2] && version.FileVersion == args[2] + ".0", "Executable version must match package.json");
            Check(assembly.GetName().Version.ToString() == args[2] + ".0", "Assembly version must match package.json");
            var results = new List<object>(); Directory.CreateDirectory(args[1]);
            foreach (var sample in new[] { "automatic", "custom", "long-password", "offline", "wide", "scaled-150", "power-risk", "power-unknown", "compatibility-limited", "compatibility-blocked" }) {
                using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset))
                using (var form = (Form)Activator.CreateInstance(type, Hidden, null, new object[] { signal }, null)) {
                    Check(form.Text == "ChatGPT 远程助手", "Product title");
                    form.Text += " - layout test"; form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-30000, -30000);
                    ((NotifyIcon)Field(form, "tray")).Visible = false;
                    Set(form, "polling", true);
                    form.Show();
                    bool custom = sample == "custom" || sample == "long-password";
                    var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>("{\"deviceId\":\"123456789\",\"code\":\"ABCD5678\",\"passwordMode\":\"automatic\",\"enabled\":true,\"connection\":\"online\",\"authorizedCount\":2,\"url\":\"https://example.invalid:9443\",\"client\":{\"available\":true,\"version\":\"26.901.6511.0\",\"reason\":null}}");
                    if (custom) data["passwordMode"] = "custom";
                    if (sample == "long-password") { data["code"] = String.Concat(Enumerable.Repeat("Ab9!", 16)); Set(form, "visibleCode", true); }
                    if (sample == "offline") { data["connection"] = "offline"; data["enabled"] = false; data["authorizedCount"] = 0; }
                    if (sample == "offline" || sample == "scaled-150") { data["connection"] = "offline"; data["connectionError"] = new Dictionary<string, object> { { "stage", "save" }, { "code", "CREDENTIAL_SAVE" }, { "message", "设备凭据保存失败，请检查安全软件拦截、磁盘空间及目录权限。" } }; }
                    if (sample.StartsWith("compatibility-")) data["client"] = new Dictionary<string, object> { { "available", sample == "compatibility-limited" }, { "version", "26.903.61454" }, { "reason", "发送消息接口需适配，请更新助手。" } };
                    if (sample == "automatic") data["update"] = new Dictionary<string, object> { { "phase", "idle" }, { "progress", 0 }, { "autoDownload", true }, { "message", "已是最新版本" }, { "notes", "" }, { "checkedAt", null } };
                    Set(form, "token", "fixture-only"); Set(form, "state", data); type.GetMethod("Render", Hidden).Invoke(form, null);
                    if (sample == "automatic") {
                        type.GetField("working", Hidden).SetValue(form, true);
                        type.GetMethod("SetControlsEnabled", Hidden).Invoke(form, null);
                        type.GetField("working", Hidden).SetValue(form, false);
                        var checking = (bool)type.GetMethod("ApplyActionResponse", Hidden).Invoke(form, new object[] { "/local/update/check", "{\"phase\":\"checking\",\"progress\":0,\"message\":\"\",\"autoDownload\":true,\"notes\":\"\",\"checkedAt\":null}" });
                        type.GetMethod("Render", Hidden).Invoke(form, null);
                        Check(checking && ((Label)Field(form, "error")).Text.Contains("正在检查更新"), "Update checks must show an in-progress status");
                        Check(!((ToolStripMenuItem)Field(form, "helpUpdateMenu")).Enabled, "Update menu must be disabled while checking");
                        type.GetMethod("ApplyActionResponse", Hidden).Invoke(form, new object[] { "/local/update/check", "{\"phase\":\"error\",\"progress\":0,\"message\":\"暂时无法检查更新，请稍后在帮助中重试。不影响当前版本使用。\"}" });
                        type.GetMethod("Render", Hidden).Invoke(form, null);
                        Check(((Label)Field(form, "error")).Text.Contains("暂时无法检查更新"), "A check failure must not appear as a failed installation");
                        var applied = (bool)type.GetMethod("ApplyActionResponse", Hidden).Invoke(form, new object[] { "/local/update/check", "{\"phase\":\"idle\",\"progress\":0,\"message\":\"已是最新版本\"}" });
                        var merged = (Dictionary<string, object>)Field(form, "state");
                        Check(applied && merged.ContainsKey("enabled") && Convert.ToBoolean(merged["enabled"]), "Update checks must preserve the device state");
                        Check(Convert.ToString(((Dictionary<string, object>)merged["update"])["phase"]) == "idle", "Update checks must merge the update state");
                        type.GetMethod("Render", Hidden).Invoke(form, null);
                        Check(((Label)Field(form, "error")).Text == "已是最新版本", "Latest-version result must be visible");
                        Check(((Label)Field(form, "error")).ForeColor == Color.FromArgb(116, 126, 137), "A successful check must clear the error color");
                        Check(((ToolStripMenuItem)Field(form, "helpUpdateMenu")).Enabled, "Update menu must be enabled after checking");
                    }
                    if (data.ContainsKey("connectionError")) Check(((Label)Field(form, "error")).Text.Contains("[save/CREDENTIAL_SAVE]"), "Connection failures must remain visible");
                    Check(((Label)Field(form, "relayStatus")).Text == (data.ContainsKey("connectionError") ? "服务器未连接" : "服务器已连接"), "Server wording");
                    if (sample.StartsWith("compatibility-")) { Check(((Label)Field(form, "clientStatus")).Text.Contains("26.903.61454"), "Show detected application version even when blocked"); Check(((Label)Field(form, "clientStatus")).Text.Contains("接口需适配"), "Show the failed compatibility check"); Check(((Label)Field(form, "clientBadge")).Text == (sample == "compatibility-limited" ? "部分兼容" : "未就绪"), "Compatibility badge"); }
                    Check(((Button)Field(form, "refreshCode")).Visible == !custom, "Refresh must be absent in fixed-password mode");
                    var revoke = (Button)Field(form, "rotate");
                    Check(revoke.AccessibleName == "撤销全部授权" && revoke.Text == "撤销全部授权", "Revoke must have explicit text");
                    Check(revoke.Image != null && !Object.ReferenceEquals(revoke.Image, ((Button)Field(form, "refreshCode")).Image), "Revoke and refresh must use different icons");
                    Check(revoke.Enabled == (sample != "offline"), "No authorizations means revoke disabled");
                    Check(((Button)Field(form, "reveal")).AccessibleName == (sample == "long-password" ? "隐藏密码" : "显示密码"), "Password visibility label");
                    form.ClientSize = sample == "wide" ? new Size(1040, 724) : sample == "automatic" ? new Size(760, 614) : new Size(form.MinimumSize.Width - (form.Width - form.ClientSize.Width), form.MinimumSize.Height - (form.Height - form.ClientSize.Height));
                    if (sample == "scaled-150") {
                        var fonts = Children(form).Select(c => new { Control = c, Font = c.Font }).ToArray();
                        var clientSize = Size.Ceiling(new SizeF(form.ClientSize.Width * 1.5f, form.ClientSize.Height * 1.5f));
                        // An empty maximum lets a small CI display clamp the off-screen test window.
                        form.AutoScaleMode = AutoScaleMode.None; form.MaximumSize = Size.Ceiling(new SizeF(form.Width * 1.5f, form.Height * 1.5f)); form.Scale(new SizeF(1.5f, 1.5f));
                        form.ClientSize = clientSize;
                        Check(form.ClientSize == clientSize, "Scaled fixture must retain its requested client area");
                        foreach (var entry in fonts) entry.Control.Font = new Font(entry.Font.FontFamily, entry.Font.Size * 1.5f, entry.Font.Style);
                    }
                    form.PerformLayout(); Application.DoEvents();
                    var feedbackMenu = (ToolStripMenuItem)Field(form, "helpFeedbackMenu");
                    Check(feedbackMenu.Text == "问题反馈", "Feedback must live under Help");
                    Check(((ToolStripMenuItem)Field(form, "trayFeedbackMenu")).Text == "问题反馈", "Tray feedback must use the same label");
                    Check(!Children(form).OfType<Button>().Any(button => button.AccessibleName == "问题反馈"), "Feedback must not occupy the footer");
                    Check(!Children(form).OfType<Label>().Any(label => label.Text == Environment.MachineName), "Machine name must not be shown");
                    var subscriptionHeight = ((Button)Field(form, "subscriptionDetails")).Parent.Height;
                    Check(subscriptionHeight == ((Button)Field(form, "powerSettings")).Parent.Height, "Subscription row must match the other status rows");
                    Check(subscriptionHeight == ((Button)Field(form, "rotate")).Parent.Height, "Authorization row must not stretch in a tall window");
                    var helperVersion = Children(form).OfType<Label>().Single(label => label.Text == "助手 v" + args[2]);
                    var helperSize = TextRenderer.MeasureText(helperVersion.Text, helperVersion.Font, Size.Empty, TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
                    Check(helperVersion.Visible && helperSize.Width <= helperVersion.Width && helperSize.Height <= helperVersion.Height, "Helper version must remain visible without clipping");
                    var power = Activator.CreateInstance(assembly.GetType("PowerAssessment"));
                    power.GetType().GetField("Available").SetValue(power, sample != "power-unknown"); power.GetType().GetField("Risk").SetValue(power, sample == "power-risk");
                    power.GetType().GetField("Summary").SetValue(power, sample == "power-risk" ? "接电空闲 30 分钟后睡眠，手机会断开" : sample == "power-unknown" ? "电源配置读取失败" : "未设置自动睡眠或休眠");
                    power.GetType().GetField("Detail").SetValue(power, "Fixture power settings"); power.GetType().GetField("Fingerprint").SetValue(power, sample);
                    Set(form, "powerAssessment", power); type.GetMethod("RenderPowerSettings", Hidden).Invoke(form, null);
                    using (var bitmap = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size)); bitmap.Save(Path.Combine(args[1], sample + ".png"), ImageFormat.Png); }
                    foreach (var control in Children(form).Where(c => c.Visible)) {
                        Check(control.Bounds.Left >= 0 && control.Bounds.Top >= 0 && control.Bounds.Right <= control.Parent.ClientSize.Width + 1 && control.Bounds.Bottom <= control.Parent.ClientSize.Height + 1, "Control outside parent: " + sample + " " + control.GetType().Name + " " + control.Text + " " + control.Bounds + " in " + control.Parent.ClientSize);
                    }
                    var errorLabel = (Label)Field(form, "error");
                    if (data.ContainsKey("connectionError")) Check(errorLabel.Text.Contains("[save/CREDENTIAL_SAVE]"), "Connection failure must survive layout and UI events");
                    Check(errorLabel.GetPreferredSize(new Size(errorLabel.Width, 0)).Height <= errorLabel.Height, "Connection failure must not be clipped");
                    Check(((Button)Field(form, "subscriptionDetails")).AccessibleName == "订阅与权益", "Subscription entry");
                    Check(((Button)Field(form, "powerSettings")).AccessibleName == "电源设置", "Power settings entry");
                    foreach (string name in new[] { "id", "relayStatus", "codeLabel", "authorization", "clientBadge", "subscriptionStatus", "powerStatus" }) {
                        var label = (Label)Field(form, name); var measured = TextRenderer.MeasureText(label.Text, label.Font, Size.Empty, TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
                        Check(measured.Width <= label.Width && measured.Height <= label.Height, "Clipped label: " + name + " " + measured + " in " + label.Size);
                    }
                    Check(Field(form, "agent") == null, "Layout tests must never start a real agent");
                    results.Add(new { sample = sample, width = form.Width, height = form.Height, verified = true });
                    Set(form, "exiting", true); form.Close();
                }
            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(results)); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
