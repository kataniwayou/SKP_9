using BaseApi.Core.Persistence;
using BaseApi.Service;
using BaseApi.Service.Features.Lookup;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Loading;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Messaging.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Lookup;

/// <summary>
/// The ordering the whole naming design rests on.
/// <para>
/// A workflow's ids reach the log store only once the orchestrator has been told to start it, and
/// enrichment is frozen at index time — a record written before its id is in the materialised policy
/// is unnamed permanently, and no later publish repairs it. So the publish must complete BEFORE the
/// control message goes out, not after. Both orders leave every call returning success, and the
/// wrong one loses exactly the records written in the busiest window of a run.
/// </para>
/// </summary>
public sealed class StartPublishesLookupBeforeSendTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");

    private sealed class Harness
    {
        public List<string> Order { get; } = [];
        public IEntityLookupPublisher Lookup { get; } = Substitute.For<IEntityLookupPublisher>();
        public IQueueSender Sender { get; } = Substitute.For<IQueueSender>();

        public OrchestrationService Build()
        {
            var now = DateTime.UtcNow;

            // A real context over the in-memory provider: the existence gate runs a genuine query,
            // so the row has to be there rather than the gate stubbed away.
            var options = new DbContextOptionsBuilder<AppDbContext>()
                .UseInMemoryDatabase($"lookup-order-{Guid.NewGuid()}").Options;
            var db = new AppDbContext(options);
            db.Set<WorkflowEntity>().Add(new WorkflowEntity { Id = W, Name = "simple-abc", Version = "1.0.0" });
            db.SaveChanges();

            // NO PROCESSORS IN THE SNAPSHOT, deliberately. The liveness gate walks
            // snapshot.Processors and touches Redis once per entry; with none it passes without a
            // single read, which keeps this test about ordering instead of about liveness stubs.
            var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
            snapshot.Workflows[W] = new WorkflowReadDto(
                W, "simple-abc", "1.0.0", null, [S], null, null, null, now, now, null, null);
            snapshot.Steps[S] = new StepReadDto(
                S, "simple-stepA", "1.0.0", null, Guid.Empty, null, default, now, now, null, null);

            var loader = Substitute.For<IWorkflowGraphLoader>();
            loader.LoadL1Async(Arg.Any<IReadOnlyList<Guid>>(), Arg.Any<CancellationToken>())
                  .Returns(Task.FromResult(snapshot));

            Lookup.PublishAsync(Arg.Any<IReadOnlyCollection<LookupRow>>(), Arg.Any<CancellationToken>())
                  .Returns(_ => { Order.Add("publish"); return Task.CompletedTask; });
            Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<object>(), Arg.Any<CancellationToken>())
                  .Returns(_ => { Order.Add("send"); return Task.CompletedTask; });

            return new OrchestrationService(
                db, loader, new CycleDetector(), new SchemaEdgeValidator(),
                new PayloadConfigSchemaValidator(),
                new ProcessorLivenessValidator(Substitute.For<IConnectionMultiplexer>(),
                                               new FakeTimeProvider(DateTimeOffset.UtcNow)),
                Sender, Lookup, NullLogger<OrchestrationService>.Instance);
        }
    }

    [Fact]
    public async Task Lookup_is_published_before_the_start_message_is_sent()
    {
        var harness = new Harness();
        var service = harness.Build();

        await service.StartAsync(W, CancellationToken.None);

        Assert.Equal(["publish", "send"], harness.Order);
    }
}
