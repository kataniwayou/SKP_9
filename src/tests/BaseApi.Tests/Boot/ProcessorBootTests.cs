using System.Diagnostics;
using System.Net;
using BaseProcessor.Core.Boot;
using Messaging.Contracts;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Boot;

public sealed class ProcessorBootTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("9e034ca0-144b-44d5-ab90-7ed53b64a728"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "sample-proc", Version: "1.0.0");

    /// <summary>A bootstrap that answers immediately, so the sequencing is what is under test.</summary>
    private sealed class Immediate : IIdentityBootstrap
    {
        public Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct)
            => Task.FromResult(Identity);
    }

    /// <summary>A bootstrap that reports what the probes said while it was still working.</summary>
    private sealed class ProbesWhileResolving : IIdentityBootstrap
    {
        private readonly int _port;
        public HttpStatusCode Startup { get; private set; }
        public HttpStatusCode Ready { get; private set; }

        public ProbesWhileResolving(int port) => _port = port;

        public async Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct)
        {
            using var http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{_port}") };
            Startup = (await http.GetAsync("/health/startup", ct)).StatusCode;
            Ready   = (await http.GetAsync("/health/ready", ct)).StatusCode;
            return Identity;
        }
    }

    private static int FreePort()
    {
        var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    [Fact]
    public async Task TheResolvedIdentityReachesTheHostBuilder()
    {
        // The identity is the entire point of the sequence: it exists so the builder can put it on a
        // resource that freezes the moment the host is built.
        ProcessorIdentityFound? seen = null;

        using var host = await ProcessorBoot.StartAsync(
            FreePort(),
            new Immediate(),
            id => { seen = id; return new HostBuilder().Build(); },
            NullLoggerFactory.Instance,
            TestContext.Current.CancellationToken);

        Assert.Equal(Identity, seen);
    }

    [Fact]
    public async Task ProbesAnswerThroughoutTheIdentityWindow()
    {
        // If these ever stop answering, an unregistered processor crash-loops instead of waiting.
        var port = FreePort();
        var bootstrap = new ProbesWhileResolving(port);

        using var host = await ProcessorBoot.StartAsync(
            port, bootstrap, _ => new HostBuilder().Build(),
            NullLoggerFactory.Instance,
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, bootstrap.Startup);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, bootstrap.Ready);
    }

    [Fact]
    public async Task TheProbePortIsFreeOnceTheHostIsBuilt()
    {
        // Stage 2's own listener takes this port. A listener still holding it would fail host startup.
        var port = FreePort();

        using var host = await ProcessorBoot.StartAsync(
            port, new Immediate(), _ => new HostBuilder().Build(),
            NullLoggerFactory.Instance,
            TestContext.Current.CancellationToken);

        await using var rebind = await BootProbeListener.StartAsync(
            port, NullLoggerFactory.Instance, TestContext.Current.CancellationToken);

        Assert.Equal(port, rebind.Address.Port);
    }

    [Fact]
    public async Task ANeverResolvingBootstrapIsCancellable()
    {
        var port = FreePort();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(1));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => ProcessorBoot.StartAsync(
                port,
                new NeverResolves(),
                _ => new HostBuilder().Build(),
                NullLoggerFactory.Instance,
                cts.Token));

        // And the port must not be left held by a listener nobody can reach any more.
        await using var rebind = await BootProbeListener.StartAsync(
            port, NullLoggerFactory.Instance, TestContext.Current.CancellationToken);
        Assert.Equal(port, rebind.Address.Port);
    }

    private sealed class NeverResolves : IIdentityBootstrap
    {
        public async Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct)
        {
            await Task.Delay(Timeout.Infinite, ct);
            throw new UnreachableException();
        }
    }
}
