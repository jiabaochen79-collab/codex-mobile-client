using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class AuditNative {
    static readonly BindingFlags Hidden = BindingFlags.Instance | BindingFlags.NonPublic;
    static object Field(Form f, string n) { return f.GetType().GetField(n, Hidden).GetValue(f); }
    static void Set(Form f, string n, object v) { f.GetType().GetField(n, Hidden).SetValue(f, v); }
    static object Call(Form f, string n, params object[] a) { return f.GetType().GetMethod(n, Hidden).Invoke(f, a); }
    static void Check(bool c, string m) { if (!c) throw new Exception(m); }
    static void Pump(Task t) { var end = DateTime.UtcNow.AddSeconds(5); while (!t.IsCompleted && DateTime.UtcNow < end) { Application.DoEvents(); Thread.Sleep(1); } Check(t.IsCompleted, "timeout"); t.GetAwaiter().GetResult(); }
    static string State(bool enabled, bool banned) { return "{\"deviceId\":\"123456789\",\"code\":\"ABCD5678\",\"passwordMode\":\"automatic\",\"enabled\":" + enabled.ToString().ToLowerInvariant() + ",\"connection\":\"online\",\"authorizedCount\":2,\"url\":\"https://example.invalid\",\"client\":{\"available\":true,\"version\":\"fixture\",\"reason\":null},\"subscription\":{\"status\":\"active\",\"disabled\":" + banned.ToString().ToLowerInvariant() + "},\"update\":{\"phase\":\"idle\",\"progress\":0}}"; }
    class Handler : HttpMessageHandler {
        internal Func<HttpRequestMessage, Task<HttpResponseMessage>> Run;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken c) { return Run(r); }
    }
    static HttpResponseMessage Response(HttpStatusCode code, string body) { return new HttpResponseMessage(code) { Content = new StringContent(body) }; }
    [STAThread] static int Main() {
        try {
            Application.EnableVisualStyles();
            using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset))
            using (var f = new CompanionForm(signal)) {
                ((NotifyIcon)Field(f, "tray")).Visible = false;
                Set(f, "nextAgentStart", DateTime.UtcNow.AddDays(1)); Set(f, "token", "fixture-only"); Set(f, "port", 12345);
                Set(f, "state", new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(State(true, false)));
                var h = new Handler(); Set(f, "http", new HttpClient(h));
                h.Run = r => Task.FromResult(Response(r.Method == HttpMethod.Post ? HttpStatusCode.Conflict : HttpStatusCode.OK, r.Method == HttpMethod.Post ? "{\"error\":{\"code\":\"UPDATE_BLOCKED\",\"message\":\"An upload is in progress\"}}" : State(true, false)));
                Pump((Task)Call(f, "Action", "/local/update/install", new {}));
                string error = ((Label)Field(f, "error")).Text;
                Check(error == "An upload is in progress", "C09 generic operation error");
                Pump((Task)Call(f, "Poll")); Check(((Label)Field(f, "error")).Text == "An upload is in progress", "C09 poll erases failure");
                Console.WriteLine("Operation reason survives polling");
                h.Run = r => r.Method == HttpMethod.Post ? Task.FromException<HttpResponseMessage>(new TaskCanceledException()) : Task.FromResult(Response(HttpStatusCode.OK, State(true, false).Replace("\"phase\":\"idle\"", "\"phase\":\"idle\",\"checkedAt\":4102444800000")));
                Pump((Task)Call(f, "Action", "/local/update/check", new {}));
                Check(Field(f, "actionError") != null, "missing uncertain update error");
                Pump((Task)Call(f, "Poll")); Check(Field(f, "actionError") == null, "successful authoritative check must clear transient error");
                h.Run = r => r.Method == HttpMethod.Post ? Task.FromException<HttpResponseMessage>(new TaskCanceledException()) : Task.FromResult(Response(HttpStatusCode.OK, State(true, false)));
                Pump((Task)Call(f, "Action", "/local/enabled", new { enabled = false }));
                Pump((Task)Call(f, "Poll")); Check(Field(f, "actionError") != null, "unconfirmed change must retain its error");
                Console.WriteLine("Only matching authoritative success clears transient action errors");
                string custom = State(true, false).Replace("\"passwordMode\":\"automatic\"", "\"passwordMode\":\"custom\"");
                Set(f, "state", new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(custom));
                h.Run = r => r.Method == HttpMethod.Post ? Task.FromException<HttpResponseMessage>(new TaskCanceledException()) : Task.FromResult(Response(HttpStatusCode.OK, custom.Replace("\"authorizedCount\":2", "\"authorizedCount\":0")));
                Pump((Task)Call(f, "Action", "/local/rotate", new {}));
                Pump((Task)Call(f, "Poll")); Check(Field(f, "actionError") == null, "A14 fixed password revocation must reconcile when grants reach zero");
                Console.WriteLine("Fixed-password authorization revocation reconciles");
                var gate = new TaskCompletionSource<HttpResponseMessage>();
                h.Run = r => r.Method == HttpMethod.Get ? gate.Task : Task.FromResult(Response(HttpStatusCode.OK, State(false, false)));
                var poll = (Task)Call(f, "Poll");
                Pump((Task)Call(f, "Action", "/local/enabled", new { enabled = false }));
                Check(!Convert.ToBoolean(((Dictionary<string, object>)Field(f, "state"))["enabled"]), "action disables");
                gate.SetResult(Response(HttpStatusCode.OK, State(true, false))); Pump(poll);
                Check(!Convert.ToBoolean(((Dictionary<string, object>)Field(f, "state"))["enabled"]), "C10 old poll replaces action");
                Console.WriteLine("Delayed poll cannot overwrite a successful action");
                Set(f, "state", new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(State(true, true))); Call(f, "Render");
                Check(((Label)Field(f, "subscriptionStatus")).Text.StartsWith("设备已被封禁"), "C11 disabled subscription shown active");
                Console.WriteLine("Banned device visibly reports its ban");
                Check(Field(f, "agent") == null, "must not start real agent");
                Set(f, "exiting", true);
            }
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
