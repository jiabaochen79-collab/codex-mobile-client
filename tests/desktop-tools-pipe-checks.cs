using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class DesktopToolsPipeChecks {
    private sealed class Endpoint : IDisposable {
        internal readonly string Path;
        internal bool ReceivedRequest;
        private NamedPipeServerStream server;
        private Task work;
        internal Endpoint(string kind, string pipePrefix = "codex-browser-use-") {
            Path = @"\\.\pipe\" + pipePrefix + Guid.NewGuid();
            server = new NamedPipeServerStream(Path.Substring(9), PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            work = Task.Run(async () => {
                try {
                    await server.WaitForConnectionAsync();
                    var header = Read(server, 4); var body = Read(server, BitConverter.ToInt32(header, 0));
                    var json = new JavaScriptSerializer(); var request = json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
                    Check(Object.Equals(request["method"], "tools/list"), "Discovery must never run a tool"); ReceivedRequest = true;
                    if (kind == "timeout") { Thread.Sleep(500); return; }
                    if (kind == "oversized") { server.Write(BitConverter.GetBytes(2 * 1024 * 1024), 0, 4); return; }
                    object response = kind == "error" ? (object)new { jsonrpc = "2.0", id = request["id"], error = new { code = -32601 } }
                        : new { jsonrpc = "2.0", id = kind == "wrong-id" ? "other-request" : request["id"], result = new { tools = new[] { new { name = "list_projects", @namespace = kind == "browser" ? "browser" : "codex_app" } } } };
                    var bytes = Encoding.UTF8.GetBytes(json.Serialize(response)); var prefix = BitConverter.GetBytes(bytes.Length);
                    server.Write(prefix, 0, 2); server.Write(prefix, 2, 2); server.Write(bytes, 0, bytes.Length); server.Flush();
                } catch (IOException) { } catch (ObjectDisposedException) { }
            });
        }
        public void Dispose() { server.Dispose(); Check(work.Wait(1500), "Fixture did not finish"); }
    }
    private static byte[] Read(Stream stream, int length) {
        var bytes = new byte[length]; var offset = 0;
        while (offset < length) { var count = stream.Read(bytes, offset, length - offset); if (count == 0) throw new EndOfStreamException(); offset += count; }
        return bytes;
    }
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static int Main() {
        try {
            var pid = Process.GetCurrentProcess().Id;
            foreach (var prefix in new[] { "codex-browser-use-", "codex-app-tools-" })
            foreach (var kind in new[] { "tools", "browser", "error", "wrong-id", "oversized", "timeout" }) {
                using (var endpoint = new Endpoint(kind, prefix)) {
                    var result = DesktopToolsPipe.Find(new[] { pid }, new[] { endpoint.Path });
                    Check(result == (kind == "tools" ? endpoint.Path : null), "Incorrect discovery for " + kind);
                }
            }
            foreach (var prefix in new[] { "codex-browser-use-", "codex-app-tools-" })
            using (var endpoint = new Endpoint("tools", prefix)) {
                Check(DesktopToolsPipe.Find(new[] { pid + 1 }, new[] { endpoint.Path }) == null, "Do not select a pipe owned by another process");
                Check(!endpoint.ReceivedRequest, "Do not send a request to an unverified pipe owner");
            }
            using (var endpoint = new Endpoint("tools")) Check(DesktopToolsPipe.Find(new[] { pid + 1, pid }, new[] { endpoint.Path }) == endpoint.Path, "Accept a pipe owned by any validated Codex process");
            using (var wrong = new Endpoint("browser")) using (var correct = new Endpoint("tools", "codex-app-tools-")) {
                Check(DesktopToolsPipe.Find(new[] { pid }, new[] { wrong.Path, correct.Path, correct.Path }) == correct.Path, "Probe candidates and deduplicate legacy discovery");
            }
            using (var first = new Endpoint("tools")) using (var second = new Endpoint("tools")) {
                Check(DesktopToolsPipe.Find(new[] { pid }, new[] { first.Path, second.Path }) == null, "Reject ambiguous tool endpoints");
            }
            using (var first = new Endpoint("tools")) using (var second = new Endpoint("tools", "codex-app-tools-")) {
                Check(DesktopToolsPipe.Find(new[] { pid }, new[] { first.Path, second.Path }) == null, "Reject ambiguous legacy and dedicated tool endpoints");
            }
            using (var endpoint = new Endpoint("tools", "codex-computer-use-")) {
                Check(DesktopToolsPipe.Find(new[] { pid }, new[] { endpoint.Path }) == null, "Reject unrelated local pipe names");
                Check(!endpoint.ReceivedRequest, "Do not probe unrelated services");
            }
            Check(DesktopToolsPipe.Find(new[] { pid }, new[] { "not-a-local-pipe", @"\\other\pipe\codex-browser-use-" + Guid.NewGuid() }) == null, "Only known local pipe names are allowed");
            Console.WriteLine("App-tool discovery checks passed"); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
