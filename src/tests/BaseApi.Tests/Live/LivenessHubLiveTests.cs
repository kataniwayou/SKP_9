using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Messaging.Contracts.Projections;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The liveness hub against a running BaseApi (<c>SKP_BASEAPI_URL</c>; a BaseApi without the hub cannot pass) and the
/// cluster's Redis. A throwaway processor row (<c>liveness-live-…</c>) whose heartbeats this test writes itself in the
/// processors' own key format, then stops writing: the hub must report it not live within a few seconds. No real
/// processor is touched.
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class LivenessHubLiveTests : IAsyncLifetime
{
    private readonly HttpClient _http = new() { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
    private readonly string _instance = $"liveness-live-{Guid.NewGuid():N}";
    private Guid _processor;
    private ConnectionMultiplexer? _redis;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        if (_redis is not null && _processor != Guid.Empty)
        {
            var db = _redis.GetDatabase();
            try
            {
                await db.SetRemoveAsync(L2ProjectionKeys.ProcessorInstances(_processor), _instance);
                await db.KeyDeleteAsync(L2ProjectionKeys.PerInstance(_processor, _instance));
            }
            catch (Exception) { }
        }
        if (_processor != Guid.Empty)
        {
            try { await _http.DeleteAsync($"/api/v1/processors/{_processor}"); } catch (Exception) { }
        }
        _redis?.Dispose();
        _http.Dispose();
    }

    /// <summary>One heartbeat as ProcessorLivenessWriter writes it: the per-instance entry and the instance index, TTL 4 x interval.</summary>
    private async Task BeatAsync(int interval)
    {
        var db = _redis!.GetDatabase();
        var entry = ProcessorLivenessEntry.Create(null, null, null, DateTime.UtcNow, interval);
        var ttl = TimeSpan.FromSeconds(interval * 4);
        await db.StringSetAsync(L2ProjectionKeys.PerInstance(_processor, _instance), JsonSerializer.Serialize(entry), ttl, When.Always, CommandFlags.None);
        await db.SetAddAsync(L2ProjectionKeys.ProcessorInstances(_processor), _instance);
        await db.KeyExpireAsync(L2ProjectionKeys.ProcessorInstances(_processor), ttl, ExpireWhen.Always, CommandFlags.None);
    }

    [Fact]
    public async Task AProcessorWhoseHeartbeatsStopIsReportedNotLiveWithinSeconds()
    {
        RealStack.SkipUnlessEnabled();
        var hash = Convert.ToHexString(Guid.NewGuid().ToByteArray().Concat(Guid.NewGuid().ToByteArray()).ToArray()).ToLowerInvariant();
        using (var created = await _http.PostAsJsonAsync("/api/v1/processors", new { SourceHash = hash, Name = $"liveness-live-{Guid.NewGuid():N}"[..30], Version = "1.0.0" }, Ct))
        {
            var text = await created.Content.ReadAsStringAsync(Ct);
            Assert.True(created.IsSuccessStatusCode, $"POST processors -> {(int)created.StatusCode}: {text}");
            _processor = JsonDocument.Parse(text).RootElement.GetProperty("id").GetGuid();
        }
        _redis = await ConnectionMultiplexer.ConnectAsync($"{RealStack.RedisHost}:{RealStack.RedisPort}");

        using var beating = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        var beats = Task.Run(async () =>
        {
            while (!beating.IsCancellationRequested)
            {
                await BeatAsync(interval: 1);
                try { await Task.Delay(500, beating.Token); } catch (OperationCanceledException) { }
            }
        }, Ct);

        await using var hub = await HubWire.ConnectAsync(new Uri(new Uri(RealStack.BaseApiUrl.Replace("http", "ws", StringComparison.Ordinal)), "/api/hubs/liveness"), Ct);
        var snapshot = await hub.InvokeAsync("Snapshot", Ct);
        var sequence = snapshot.GetProperty("sequence").GetInt64();
        Assert.True(snapshot.GetProperty("known").GetBoolean(), "the monitor reads Redis");

        bool LiveIn(JsonElement processors) => processors.EnumerateArray()
            .Any(p => p.GetProperty("processorId").GetGuid() == _processor && p.GetProperty("live").GetBoolean());
        if (!LiveIn(snapshot.GetProperty("processors")))
        {
            var live = await hub.WaitForAsync("ProcessorLiveness", m => m.GetProperty("processorId").GetGuid() == _processor && m.GetProperty("live").GetBoolean(), TimeSpan.FromSeconds(15), Ct);
            Assert.True(live.GetProperty("sequence").GetInt64() > sequence);
            Assert.Equal(1, live.GetProperty("healthy").GetInt32());
        }

        await beating.CancelAsync();
        await beats;
        var stopped = DateTime.UtcNow;

        var dead = await hub.WaitForAsync("ProcessorLiveness", m => m.GetProperty("processorId").GetGuid() == _processor && !m.GetProperty("live").GetBoolean(), TimeSpan.FromSeconds(15), Ct);
        var after = DateTime.UtcNow - stopped;
        // stale once timestamp + 2 x 1 s <= now, read every 2 s: about 4 s at most, with slack for the round trips
        Assert.True(after < TimeSpan.FromSeconds(8), $"reported not live after {after.TotalSeconds:0.0} s");
        Assert.StartsWith("no healthy replica (1 checked:", dead.GetProperty("reason").GetString(), StringComparison.Ordinal);
        Assert.False(dead.GetProperty("removed").GetBoolean());

        // the snapshot agrees, and its sequence covers the change
        var after2 = await hub.InvokeAsync("Snapshot", Ct);
        Assert.True(after2.GetProperty("sequence").GetInt64() >= dead.GetProperty("sequence").GetInt64());
        Assert.False(LiveIn(after2.GetProperty("processors")));
        Assert.True(hub.SequencesIncrease, "every broadcast carries a sequence number above the one before");
    }

    /// <summary>
    /// The SignalR JSON protocol over a bare WebSocket, enough for one test: handshake, invoke, receive, ping. (No client
    /// package: the repo's offline feed would need it, and the protocol is a few lines.)
    /// </summary>
    private sealed class HubWire : IAsyncDisposable
    {
        private const char Separator = '\u001e';
        private readonly ClientWebSocket _socket = new();
        private readonly Channel<JsonElement> _messages = Channel.CreateUnbounded<JsonElement>();
        private readonly CancellationTokenSource _stop = new();
        private Task _reader = Task.CompletedTask;
        private Task _pinger = Task.CompletedTask;
        private int _invocations;
        private long _lastSequence = -1;

        public bool SequencesIncrease { get; private set; } = true;

        public static async Task<HubWire> ConnectAsync(Uri uri, CancellationToken ct)
        {
            var wire = new HubWire();
            await wire._socket.ConnectAsync(uri, ct);
            await wire.SendAsync("""{"protocol":"json","version":1}""", ct);
            wire._reader = Task.Run(wire.ReadAsync, CancellationToken.None);
            wire._pinger = Task.Run(async () =>
            {
                while (!wire._stop.IsCancellationRequested)
                {
                    try { await Task.Delay(5000, wire._stop.Token); await wire.SendAsync("""{"type":6}""", wire._stop.Token); }
                    catch (Exception) { return; }
                }
            }, CancellationToken.None);
            return wire;
        }

        private readonly SemaphoreSlim _sending = new(1, 1);

        private async Task SendAsync(string json, CancellationToken ct)
        {
            await _sending.WaitAsync(ct);
            try { await _socket.SendAsync(Encoding.UTF8.GetBytes(json + Separator), WebSocketMessageType.Text, true, ct); }
            finally { _sending.Release(); }
        }

        private async Task ReadAsync()
        {
            var buffer = new byte[64 * 1024];
            var pending = new StringBuilder();
            try
            {
                while (_socket.State == WebSocketState.Open && !_stop.IsCancellationRequested)
                {
                    var result = await _socket.ReceiveAsync(buffer, _stop.Token);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    pending.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                    var text = pending.ToString();
                    var end = text.LastIndexOf(Separator);
                    if (end < 0) continue;
                    pending.Clear().Append(text[(end + 1)..]);
                    foreach (var frame in text[..end].Split(Separator))
                    {
                        if (frame.Length == 0) continue;
                        var message = JsonDocument.Parse(frame).RootElement.Clone();
                        // the handshake answer has no type; pings (6) carry nothing
                        if (!message.TryGetProperty("type", out var kind) || kind.GetInt32() == 6) continue;
                        if (message.TryGetProperty("type", out var type) && type.GetInt32() == 1 && message.GetProperty("arguments").GetArrayLength() == 1
                            && message.GetProperty("arguments")[0].TryGetProperty("sequence", out var seq))
                        {
                            if (seq.GetInt64() <= _lastSequence) SequencesIncrease = false;
                            _lastSequence = seq.GetInt64();
                        }
                        await _messages.Writer.WriteAsync(message);
                    }
                }
            }
            catch (Exception) { }
            _messages.Writer.TryComplete();
        }

        /// <summary>Invokes a hub method with no arguments and returns its result; broadcasts read meanwhile are kept.</summary>
        public async Task<JsonElement> InvokeAsync(string target, CancellationToken ct)
        {
            var id = (++_invocations).ToString(System.Globalization.CultureInfo.InvariantCulture);
            await SendAsync($$"""{"type":1,"invocationId":"{{id}}","target":"{{target}}","arguments":[]}""", ct);
            var completion = await NextAsync(m => m.GetProperty("type").GetInt32() == 3 && m.GetProperty("invocationId").GetString() == id, TimeSpan.FromSeconds(15), ct);
            if (completion.TryGetProperty("error", out var error)) throw new InvalidOperationException($"{target} failed: {error.GetString()}");
            return completion.GetProperty("result");
        }

        /// <summary>The first broadcast of <paramref name="target"/> whose argument matches, within <paramref name="timeout"/>.</summary>
        public async Task<JsonElement> WaitForAsync(string target, Func<JsonElement, bool> match, TimeSpan timeout, CancellationToken ct)
        {
            var message = await NextAsync(m => m.GetProperty("type").GetInt32() == 1
                && string.Equals(m.GetProperty("target").GetString(), target, StringComparison.OrdinalIgnoreCase)
                && match(m.GetProperty("arguments")[0]), timeout, ct);
            return message.GetProperty("arguments")[0];
        }

        private readonly List<JsonElement> _kept = [];

        private async Task<JsonElement> NextAsync(Func<JsonElement, bool> match, TimeSpan timeout, CancellationToken ct)
        {
            var found = _kept.FindIndex(m => match(m));
            if (found >= 0) { var m = _kept[found]; _kept.RemoveAt(found); return m; }
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(timeout);
            try
            {
                while (true)
                {
                    var message = await _messages.Reader.ReadAsync(limit.Token);
                    if (match(message)) return message;
                    _kept.Add(message);
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new TimeoutException($"no matching hub message within {timeout.TotalSeconds:0} s");
            }
        }

        public async ValueTask DisposeAsync()
        {
            await _stop.CancelAsync();
            try { await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None); } catch (Exception) { }
            await Task.WhenAll(_reader, _pinger);
            _socket.Dispose();
            _stop.Dispose();
            _sending.Dispose();
        }
    }
}
