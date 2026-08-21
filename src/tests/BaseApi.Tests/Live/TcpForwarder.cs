using System.Net;
using System.Net.Sockets;

namespace BaseApi.Tests.Live;

/// <summary>
/// A loopback TCP endpoint a test can switch on partway through: closed at first, so connections to
/// it are refused, and forwarding to a real service once <see cref="Open"/> is called.
/// <para>
/// <b>Why a forwarder rather than stopping the real dependency.</b> The cluster these tests run
/// against is shared and long-lived — deleting the Redis pod would break the running deployment, and
/// every <c>kubectl port-forward</c> in <c>k8s/port-forward-realstack.ps1</c> dies with the pod it
/// points at, so a test that took Redis down would take the rest of the live suite with it and leave
/// the developer's forwards to be restarted by hand. Moving the outage into a port this process owns
/// keeps the blast radius inside the test while leaving the thing under test — a real
/// <c>ConnectionMultiplexer</c> speaking RESP over a real socket to a real Redis — completely real.
/// </para>
/// <para>
/// <b>Refused, not merely silent, and the difference matters.</b> A listener that accepts and then
/// never answers would leave the client waiting on its own timeouts, which is a slow dependency, not
/// an absent one. Nothing is bound at all until <see cref="Open"/>, so the kernel answers with RST
/// and the client sees the same immediate failure it would see against a dead host.
/// </para>
/// </summary>
internal sealed class TcpForwarder : IAsyncDisposable
{
    private readonly string _targetHost;
    private readonly int _targetPort;
    private readonly CancellationTokenSource _cts = new();

    private TcpListener? _listener;

    private TcpForwarder(int port, string targetHost, int targetPort)
    {
        Port        = port;
        _targetHost = targetHost;
        _targetPort = targetPort;
    }

    /// <summary>The loopback port this forwarder owns, valid before it is opened as well as after.</summary>
    public int Port { get; }

    /// <summary>
    /// The address to point a client at. Explicitly numeric rather than <c>localhost</c>: see
    /// <see cref="Listen"/> for what that name costs.
    /// </summary>
    public string Endpoint => $"127.0.0.1:{Port}";

    /// <summary>
    /// Reserves a free loopback port and leaves it closed. The port is discovered by binding to :0,
    /// reading what the OS assigned and releasing it again — which is racy in principle, since another
    /// process could take the port in the gap. In practice the ephemeral range is not under contention
    /// on a developer machine, and the alternative — holding the socket bound — is exactly the
    /// accept-then-hang behaviour the type remarks rule out.
    /// </summary>
    public static TcpForwarder ReserveClosed(string targetHost, int targetPort)
    {
        var probe = Listen(0);
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();

        return new TcpForwarder(port, targetHost, targetPort);
    }

    /// <summary>
    /// A dual-stack loopback listener, which is not the default and is load-bearing here.
    /// <para>
    /// <b>An IPv4-only listener produces a forwarder that is open and still unreachable.</b> On
    /// Windows <c>localhost</c> resolves to <c>::1</c> ahead of <c>127.0.0.1</c>, so a client given
    /// the name connects over IPv6, finds nothing bound, and fails exactly as it would against a
    /// closed port — turning this class into a machine for producing false failures that look like
    /// the very outage it is meant to stage. Binding <see cref="IPAddress.IPv6Any"/> with
    /// <see cref="Socket.DualMode"/> accepts both, which is also what <c>kubectl port-forward</c>
    /// does; <see cref="Endpoint"/> then names the numeric address so a caller does not have to know
    /// any of this.
    /// </para>
    /// </summary>
    private static TcpListener Listen(int port)
    {
        var listener = new TcpListener(IPAddress.IPv6Any, port);
        listener.Server.DualMode = true;
        listener.Start();

        return listener;
    }

    /// <summary>Starts listening and forwarding. This is the moment the dependency "comes back".</summary>
    public void Open()
    {
        _listener = Listen(Port);

        // Not awaited: the accept loop runs for the life of the forwarder and is ended by the CTS.
        _ = AcceptAsync(_listener, _cts.Token);
    }

    private async Task AcceptAsync(TcpListener listener, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient inbound;
            try
            {
                inbound = await listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Cancelled, or the listener was stopped out from under us by disposal. Both mean the
                // forwarder is finished; neither is a fault the test should see.
                return;
            }

            _ = PumpAsync(inbound, ct);
        }
    }

    private async Task PumpAsync(TcpClient inbound, CancellationToken ct)
    {
        using (inbound)
        {
            using var outbound = new TcpClient();

            try
            {
                await outbound.ConnectAsync(_targetHost, _targetPort, ct).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // The far side is not there. Dropping the inbound connection is the honest answer, and
                // the client under test is expected to survive exactly this.
                return;
            }

            var toTarget = CopyAsync(inbound.GetStream(), outbound.GetStream(), ct);
            var toClient = CopyAsync(outbound.GetStream(), inbound.GetStream(), ct);

            // WhenAny, not WhenAll: only one direction ends on its own when a peer goes away, and the
            // other unblocks when the streams are disposed on the way out of this scope. Neither task
            // can fault — CopyAsync swallows — so the one left behind is never an unobserved exception.
            await Task.WhenAny(toTarget, toClient).ConfigureAwait(false);
        }
    }

    private static async Task CopyAsync(Stream from, Stream to, CancellationToken ct)
    {
        try
        {
            await from.CopyToAsync(to, ct).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // A closed or cancelled hop. The opposite direction ends with it.
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _cts.CancelAsync().ConfigureAwait(false);
        _listener?.Stop();
        _cts.Dispose();
    }
}
