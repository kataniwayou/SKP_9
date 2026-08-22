namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Every message template the scenarios count, copied from the emitting call site.
/// <para>
/// <b>Templates, not rendered text.</b> The OpenTelemetry bridge puts the unsubstituted template on
/// <c>attributes.{OriginalFormat}</c> as a keyword, so "the step returned after {ElapsedMs}ms" is one
/// bucket where the rendered text would be one bucket per distinct duration. A verifier written
/// against rendered text miscounts the moment a step's timing varies, which is always.
/// </para>
/// <para>
/// <b>The em dashes are written as backslash-u-2014 escapes.</b> Several of these templates carry U+2014.
/// Spelling it literally makes the constant's correctness depend on the file's encoding surviving
/// every editor and tool that touches it, and a template that differs by one byte matches nothing
/// and reports a lost step. The escape is unambiguous.
/// </para>
/// </summary>
internal static class Templates
{
    // ---- the ledger: the ten templates a complete run emits ----

    public const string EntryDispatched = "dispatched an entry step";
    public const string HandoffDispatched = "dispatched in {ElapsedMs}ms";
    public const string RunningTheStep = "running the step";
    public const string AuthorConfig = "config gives label {Label} and number {Number}";
    public const string StepReturned = "the step returned after {ElapsedMs}ms";
    public const string BranchCompleted = "branch completed in {ElapsedMs}ms";
    public const string EntryStepCompleted = "the entry step completed with {Result}";
    public const string HandedOff =
        "handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}";
    public const string AdvancedSuccessors = "advanced {SuccessorCount} successor(s) in {ElapsedMs}ms";
    public const string TerminalCompleted =
        "the terminal step completed with {Result} \u2014 no successor accepts it, the run ends here";

    // ---- the accounting vocabulary: the legitimate excuses for a short ledger, in two tiers ----
    // (see the two lists below the ledger for why they are not one list)

    public const string StoreUnreachable =
        "projection store unreachable \u2014 returning message to {Queue}";
    public const string RefusingAndParking = "refusing message of type {Type} \u2014 parking";
    public const string SendFailedReturning =
        "send failed while handling {Type} \u2014 returning message to {Queue}";
    public const string EntryDispatchSendFailed = "the entry-step dispatch failed to send; continuing";
    public const string EntryAbsentDuplicate = "entry absent \u2014 treating as a duplicate delivery";

    // ---- fault arrival and heal, witnessed rather than assumed ----

    public const string GateClosed =
        "L2 gate closed \u2014 projection store unusable, consumers paused";
    public const string GateOpen =
        "L2 gate open \u2014 projection store healthy, consumers may run";
    public const string ChannelShutDown = "channel shut down: {Reason} \u2014 will reopen";
    public const string ConnectionRecovered = "connection recovered \u2014 delivery tags invalidated";
    public const string ConsumptionPaused =
        "consumption no longer admitted or the projection store unhealthy \u2014 paused consuming {Queue}";
    public const string ConsumptionAdmitted =
        "consumption admitted and the projection store healthy \u2014 consuming {Queue}";

    /// <summary>The ten ledger templates, for building a histogram with every bucket present.</summary>
    public static readonly IReadOnlyList<string> Ledger =
    [
        EntryDispatched, HandoffDispatched, RunningTheStep, AuthorConfig, StepReturned,
        BranchCompleted, EntryStepCompleted, HandedOff, AdvancedSuccessors, TerminalCompleted,
    ];

    /// <summary>
    /// The templates a run's own records can be. The run query filters on these as well as on
    /// WorkflowId, because the API's control-plane endpoints (start, stop) carry WorkflowId on some
    /// of their own log lines too, and each such request is stamped with its own request-scoped
    /// CorrelationId by CorrelationIdMiddleware — indistinguishable from a run's CorrelationId to a
    /// query that only checks WorkflowId. Without this second filter, each start and each stop groups
    /// into its own phantom "run" with an empty ledger, which breaches I5 and reads as a lost step
    /// that never happened.
    /// </summary>
    public static readonly IReadOnlyList<string> RunScoped =
    [
        .. Ledger, EntryAbsentDuplicate, EntryDispatchSendFailed,
    ];

    /// <summary>
    /// Excuses that ride a run's own CorrelationId, because they are logged inside a handler scope,
    /// after the message has been deserialized and the ids it carries are readable.
    /// </summary>
    public static readonly IReadOnlyList<string> RunScopedExcuses =
    [
        EntryAbsentDuplicate, EntryDispatchSendFailed,
    ];

    /// <summary>
    /// Excuses that cannot be attributed to a run. GatedQueueConsumer logs these from its catch
    /// block, above the deserialization boundary, where the correlation, workflow, and step ids are
    /// still undecoded bytes and cannot be put on the record. They account for a run only by being
    /// present somewhere in the observed fault window — weaker than a per-run attribution, and the
    /// strongest claim these records can support.
    /// </summary>
    public static readonly IReadOnlyList<string> ProcessScopedExcuses =
    [
        StoreUnreachable, RefusingAndParking, SendFailedReturning,
    ];

    // ---- worker lifecycle edges, for S6 and S7 ----

    /// <summary>
    /// Emitted by Microsoft.Hosting.Lifetime, so EVERY service in the deployment writes it. Matching
    /// it without also filtering on the service name witnesses the wrong process, which is why
    /// ReadTemplateRecordsAsync takes a service filter.
    /// </summary>
    public const string HostShuttingDown = "Application is shutting down...";

    /// <summary>Processor-unique: its startup loops stand down once it is serving.</summary>
    public const string ProcessorLoopsRetired = "processor healthy; startup loops retired";

    /// <summary>Orchestrator-unique: Quartz runs nowhere else in this deployment.</summary>
    public const string SchedulerShuttingDown = "Scheduler {0} shutting down.";

    /// <summary>Orchestrator-unique: the hydration record no other role writes.</summary>
    public const string OrchestratorHydrated =
        "hydrated {WorkflowCount} workflows from L2; admitting the consumer";
}
