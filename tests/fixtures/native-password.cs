using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
internal static class PasswordAudit {
    static readonly BindingFlags Hidden = BindingFlags.Instance | BindingFlags.NonPublic;
    static object Field(Form f, string n) { return f.GetType().GetField(n, Hidden).GetValue(f); }
    static void Set(Form f, string n, object v) { f.GetType().GetField(n, Hidden).SetValue(f, v); }
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    class Handler : HttpMessageHandler {
        public int Count;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
            Count++;
            return Task.FromResult(new HttpResponseMessage(Count == 1 ? HttpStatusCode.InternalServerError : HttpStatusCode.OK) { Content = new StringContent(Count == 1 ? "{\"error\":{\"message\":\"fixture rejection\"}}" : "{\"deviceId\":\"123456789\",\"code\":\"fixture-password-draft\",\"passwordMode\":\"custom\",\"enabled\":false,\"client\":null}") });
        }
    }
    [STAThread] static int Main() {
        try {
            Application.EnableVisualStyles();
            using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset))
            using (var form = new CompanionForm(signal)) {
                ((NotifyIcon)Field(form, "tray")).Visible = false;
                Set(form, "nextAgentStart", DateTime.UtcNow.AddDays(1)); Set(form, "token", "fixture-only"); Set(form, "port", 12345);
                Set(form, "state", new JavaScriptSerializer().Deserialize<Dictionary<string, object>>("{\"deviceId\":\"123456789\",\"code\":\"fixture-old\",\"passwordMode\":\"automatic\",\"enabled\":false}"));
                var handler = new Handler(); Set(form, "http", new HttpClient(handler));
                bool entered = false, preserved = false; var deadline = DateTime.UtcNow.AddSeconds(4);
                using (var timer = new System.Windows.Forms.Timer { Interval = 20 }) {
                    timer.Tick += (s, e) => {
                        foreach (Form modal in Application.OpenForms) {
                            if (modal == form || modal.Text != "\u5bc6\u7801\u8bbe\u7f6e") continue;
                            TextBox text = null; RadioButton custom = null; Button save = null;
                            foreach (Control c in modal.Controls) {
                                if (c is TextBox) text = (TextBox)c;
                                if (c is RadioButton && c.Text.StartsWith("\u81ea\u5b9a\u4e49")) custom = (RadioButton)c;
                                if (c is Button && c.Text == "\u4fdd\u5b58") save = (Button)c;
                            }
                            if (DateTime.UtcNow > deadline) { Console.WriteLine("fixture timeout count=" + handler.Count + " working=" + Field(form, "working") + " tokenPresent=" + (Field(form, "token") != null)); timer.Stop(); modal.DialogResult = DialogResult.Cancel; return; }
                            if (!entered) { custom.Checked = true; text.Text = "fixture-password-draft"; entered = true; save.PerformClick(); return; }
                            if (handler.Count == 1 && save.Enabled) {
                                preserved = text.Text == "fixture-password-draft" && ((Label)Field(form, "error")).Text == "fixture rejection";
                                timer.Stop(); save.PerformClick(); return;
                            }
                        }
                    };
                    timer.Start(); var task = (Task)form.GetType().GetMethod("EditPassword", Hidden).Invoke(form, new object[0]);
                    task.GetAwaiter().GetResult();
                }
                Check(entered && preserved && handler.Count == 2, "password retry did not preserve draft");
                Check(Field(form, "agent") == null, "real helper must not start"); Set(form, "exiting", true);
                Console.WriteLine("Rejected password save preserves entered draft and successful retry closes dialog");
            }
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
