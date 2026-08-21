using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class ConsumerAdmissionTests
{
    private sealed class Latch : IConsumerAdmission
    {
        public bool IsOpen { get; set; }
    }

    [Fact]
    public void TheDefaultIsOpenSoAnExistingHostIsUnaffected()
    {
        // The processor gets this one. Its consumption timing must not move because a second service
        // wanted a gate.
        Assert.True(new AlwaysOpenAdmission().IsOpen);
    }

    /// <summary>
    /// Builds a real <see cref="GatedQueueConsumer"/> without ever starting it. Its constructor does
    /// no I/O — it only assigns fields — so a <see cref="RabbitMqConnection"/> that has never opened a
    /// socket, and an <see cref="IServiceScopeFactory"/> pulled from an otherwise-empty provider, are
    /// enough to exercise <see cref="GatedQueueConsumer.ShouldConsume"/> without a broker.
    /// </summary>
    private static GatedQueueConsumer BuildConsumer(IConsumerAdmission admission, L2Gate gate)
    {
        var connection = new RabbitMqConnection(
            Options.Create(new RabbitMqOptions()),
            Array.Empty<IRabbitMqTopology>(),
            NullLogger<RabbitMqConnection>.Instance);

        var scopes = new ServiceCollection()
            .BuildServiceProvider()
            .GetRequiredService<IServiceScopeFactory>();

        return new GatedQueueConsumer(
            connection,
            gate,
            scopes,
            Options.Create(new GatedConsumerOptions { Queue = "some-queue" }),
            admission,
            NullLogger<GatedQueueConsumer>.Instance);
    }

    // All four combinations, not just the two where admission and the gate agree: a conjunction typed
    // as a disjunction, or as _gate.IsOpen alone with admission ignored entirely, still passes a
    // two-case version of this test. Only open x open may consume.
    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, true)]
    public async Task ShouldConsumeRequiresBothAdmissionAndTheL2GateOpen(
        bool admissionOpen, bool gateOpen, bool expected)
    {
        var admission = new Latch { IsOpen = admissionOpen };

        // L2Gate is constructed closed by design (see its own remarks) — reporting healthy is the
        // only way to drive it open, and never calling that leaves it closed.
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        if (gateOpen)
        {
            await gate.ReportHealthyAsync();
        }

        var consumer = BuildConsumer(admission, gate);

        Assert.Equal(expected, consumer.ShouldConsume);
    }

    [Fact]
    public void ARegisteredAdmissionStandsDownTheDefault()
    {
        // What lets a host bring its own admission at all, and what the orchestrator's hydration
        // latch depends on: a host that registers its own IConsumerAdmission before calling
        // AddBaseConsoleGating must get that implementation resolved, not AlwaysOpenAdmission —
        // TryAddSingleton only takes effect when nothing has claimed the slot yet.
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<TimeProvider>(new FakeTimeProvider());
        services.AddSingleton<IConsumerAdmission>(new Latch { IsOpen = true });

        var cfg = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>()).Build();
        services.AddBaseConsoleGating(cfg, "some-work-queue");

        using var sp = services.BuildServiceProvider(validateScopes: true);

        Assert.IsType<Latch>(sp.GetRequiredService<IConsumerAdmission>());
    }
}
