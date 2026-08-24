using BaseApi.Core.DependencyInjection;
using BaseApi.Core.Messaging;
using BaseApi.Service.Features.Orchestration.Messaging;
using BaseApi.Service.Features.Processor.Responders;
using BaseApi.Service.Features.Schema.Responders;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Composition;

/// <summary>
/// Binds this service's messaging: the topology it owns, the queues it consumes, and the handlers
/// that answer them.
/// <para>
/// <b>This service sends to a queue it also consumes, and that is intentional rather than a
/// shortcut.</b> The round trip through the broker is what makes the projection write survive an
/// outage of the projection store: the request is validated and acknowledged while the store is
/// unreachable, the message waits durably, and the write happens when the store returns. An in-process
/// hand-off would lose exactly that, and would lose it silently — the work would simply never happen.
/// </para>
/// <para>
/// <b>Two kinds of consumer, gated differently on purpose.</b> The control queue writes to the
/// projection store, so it runs only while the gate is open. The query queues read from the database,
/// so they are never paused: pausing them would spread one dependency's outage to callers who were
/// not depending on it.
/// </para>
/// </summary>
internal static class AppMessaging
{
    public static IServiceCollection AddAppMessaging(
        this IServiceCollection services, IConfiguration cfg)
    {
        // Connection, send primitive, and the gate with its probe loop.
        services.AddBaseApiMessaging(cfg);
        services.AddBaseApiL2Gate(cfg);

        // Topology is declared as part of opening the connection, before anything sends or consumes,
        // so a queue exists even while its consumer is paused.
        services.AddSingleton<IRabbitMqTopology, OrchestrationTopology>();
        services.AddSingleton<IRabbitMqTopology, FanoutTopology>();
        services.AddSingleton<IRabbitMqTopology, QueryTopology>();

        // How deep the queues this API sends to are getting, and whether anything is listening.
        //
        // THE API IS THE ONLY PROCESS THAT CAN SEE orchestrator-control WHILE THE ORCHESTRATOR IS
        // GONE. It is the one publishing start and stop requests into that queue, so they pile up
        // there with nothing to take them -- and the orchestrator, being absent, cannot report its
        // own backlog. Measured before this existed: with the orchestrator scaled to zero the
        // number of queues observed anywhere fell from 7 to 1, and `Queues unconsumed` read a
        // confident 0, unable to tell "none unconsumed" from "six unobservable".
        //
        // The list is whatever this process has SENT to -- QueueSender records every destination --
        // so it needs no static queue names and nothing to keep in step with another role's
        // topology. DispatchedQueues.Note lets a queue the broker says is gone stop being probed,
        // which matters more here than anywhere: the API sends to a per-replica reply queue for
        // every processor it ever answers.
        services.AddHostedService(sp => new QueueDepthProbe(
            sp.GetRequiredService<RabbitMqConnection>(),
            DispatchedQueues.Snapshot,
            TimeSpan.FromSeconds(10),
            sp.GetRequiredService<ILogger<QueueDepthProbe>>(),
            DispatchedQueues.Note));

        // The gated control consumer, and the two handlers it dispatches to by message type.
        services.AddBaseApiGatedConsumer(OrchestratorQueues.Control);
        services.AddScoped<IQueueMessageHandler, StartOrchestrationHandler>();
        services.AddScoped<IQueueMessageHandler, StopOrchestrationHandler>();

        // The ungated query consumers. One per queue, each constructed with the queue it serves —
        // there is no shared options object to collide over.
        services.AddScoped<IRpcHandler, GetProcessorBySourceHashHandler>();
        services.AddScoped<IRpcHandler, GetSchemaDefinitionHandler>();

        // Registered as plain singletons rather than through AddHostedService, and that is not a
        // style choice: AddHostedService de-duplicates by implementation type, so the second
        // RpcQueueConsumer would be silently discarded and its queue would never be served — with no
        // error, and nothing in the logs except the absence of one consumer.
        foreach (var queue in new[] { ProcessorQueues.IdentityQuery, ProcessorQueues.SchemaQuery })
        {
            var served = queue;
            services.AddSingleton<IHostedService>(sp => new RpcQueueConsumer(
                served,
                sp.GetRequiredService<RabbitMqConnection>(),
                sp.GetRequiredService<IServiceScopeFactory>(),
                sp.GetRequiredService<ILogger<RpcQueueConsumer>>()));
        }

        return services;
    }
}
