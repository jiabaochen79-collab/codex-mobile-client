using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class DesktopToolsPipe {
    private const string Prefix = @"\\.\pipe\codex-browser-use-";
    private const int MaxFrame = 1024 * 1024;
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);

    internal static string Find(IEnumerable<int> allowedOwnerProcessIds, IEnumerable<string> candidates) {
        var allowedOwners = new HashSet<int>(allowedOwnerProcessIds ?? Enumerable.Empty<int>());
        if (allowedOwners.Count == 0) return null;
        var paths = candidates.Where(IsCandidate).Distinct(StringComparer.OrdinalIgnoreCase).Take(17).ToArray();
        if (paths.Length > 16) return null;
        string found = null;
        foreach (var path in paths) {
            if (!Probe(path, allowedOwners)) continue;
            if (found != null) return null;
            found = path;
        }
        return found;
    }
    private static bool IsCandidate(string path) {
        Guid id;
        return path != null && path.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase) && Guid.TryParseExact(path.Substring(Prefix.Length), "D", out id);
    }
    private static bool Probe(string path, ISet<int> allowedOwnerProcessIds) {
        try {
            using (var pipe = new NamedPipeClientStream(".", path.Substring(9), PipeDirection.InOut, PipeOptions.Asynchronous)) {
                pipe.Connect(100);
                uint owner;
                if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out owner) || !allowedOwnerProcessIds.Contains((int)owner)) return false;
                // Multiple services share this prefix. Verify the app-tool protocol before using one.
                var json = new JavaScriptSerializer { MaxJsonLength = MaxFrame };
                var id = Guid.NewGuid().ToString();
                var body = Encoding.UTF8.GetBytes(json.Serialize(new { jsonrpc = "2.0", id = id, method = "tools/list", @params = new { threadStartKind = "all" } }));
                var frame = new byte[body.Length + 4]; Buffer.BlockCopy(BitConverter.GetBytes(body.Length), 0, frame, 0, 4); Buffer.BlockCopy(body, 0, frame, 4, body.Length);
                var clock = Stopwatch.StartNew();
                if (!pipe.WriteAsync(frame, 0, frame.Length).Wait(300)) return false;
                var header = ReadExactly(pipe, 4, clock); var length = BitConverter.ToInt32(header, 0);
                if (length <= 0 || length > MaxFrame) return false;
                var response = json.DeserializeObject(Encoding.UTF8.GetString(ReadExactly(pipe, length, clock))) as Dictionary<string, object>;
                object requestId, result, rawTools, version;
                if (response == null || !response.TryGetValue("jsonrpc", out version) || !Object.Equals(version, "2.0") || !response.TryGetValue("id", out requestId) || !Object.Equals(requestId, id) || response.ContainsKey("error") || !response.TryGetValue("result", out result)) return false;
                var catalog = result as Dictionary<string, object>;
                if (catalog == null || !catalog.TryGetValue("tools", out rawTools) || !(rawTools is object[])) return false;
                return ((object[])rawTools).OfType<Dictionary<string, object>>().Any(tool => tool.ContainsKey("namespace") && Object.Equals(tool["namespace"], "codex_app") && tool.ContainsKey("name") && Object.Equals(tool["name"], "list_projects"));
            }
        } catch { return false; }
    }
    private static byte[] ReadExactly(NamedPipeClientStream pipe, int length, Stopwatch clock) {
        var buffer = new byte[length]; var offset = 0;
        while (offset < length) {
            var remaining = 300 - (int)clock.ElapsedMilliseconds;
            if (remaining <= 0) throw new TimeoutException();
            var read = pipe.ReadAsync(buffer, offset, length - offset);
            if (!read.Wait(remaining)) throw new TimeoutException();
            if (read.Result == 0) throw new EndOfStreamException();
            offset += read.Result;
        }
        return buffer;
    }
}
