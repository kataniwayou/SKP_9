using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Orchestration.Loading;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using FluentValidation.Results;
using Microsoft.EntityFrameworkCore;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// The dry run behind <c>POST /workflows/{id}/validate</c>: apply the draft with the real graph saver,
/// load the result with the loader the start path uses, collect every gate's problems in the start's
/// locked order, and roll everything back.
/// <para>
/// <b>Nothing escapes.</b> This never builds a start definition, never sends to the broker and never
/// writes Redis; its only Redis access is the read-only liveness probe. The draft's database writes live
/// inside <see cref="IGraphDryRun"/>, which always rolls back.
/// </para>
/// <para>
/// <b>Request-shape failures keep the save's statuses.</b> A draft with field errors is a 400, a stale
/// draft a 409, an FK violation a 422, exactly as <c>PUT /graph</c> would answer; only the gates' own
/// problems are returned as data.
/// </para>
/// </summary>
internal sealed class WorkflowValidator : IWorkflowValidator
{
    private readonly BaseDbContext _db;
    private readonly IWorkflowGraphSaver _saver;
    private readonly IWorkflowGraphLoader _loader;
    private readonly CycleDetector _cycles;
    private readonly SchemaEdgeValidator _schemaEdges;
    private readonly PayloadConfigSchemaValidator _payloads;
    private readonly ProcessorLivenessValidator _liveness;
    private readonly IGraphDryRun _dryRun;

    public WorkflowValidator(
        BaseDbContext db,
        IWorkflowGraphSaver saver,
        IWorkflowGraphLoader loader,
        CycleDetector cycles,
        SchemaEdgeValidator schemaEdges,
        PayloadConfigSchemaValidator payloads,
        ProcessorLivenessValidator liveness,
        IGraphDryRun dryRun)
    {
        _db = db;
        _saver = saver;
        _loader = loader;
        _cycles = cycles;
        _schemaEdges = schemaEdges;
        _payloads = payloads;
        _liveness = liveness;
        _dryRun = dryRun;
    }

    public Task<WorkflowValidationDto> ValidateAsync(Guid workflowId, GraphSaveRequest? draft, CancellationToken ct)
    {
        if (workflowId == Guid.Empty)
        {
            throw new ValidationException(new[] { new ValidationFailure(nameof(workflowId), "WorkflowId must not be Guid.Empty.") });
        }

        return _dryRun.RunAsync(async c =>
        {
            if (draft is not null)
            {
                await _saver.SaveAsync(workflowId, draft, c);
            }
            else if (!await _db.Set<WorkflowEntity>().AsNoTracking().AnyAsync(w => w.Id == workflowId, c))
            {
                throw new NotFoundException(nameof(WorkflowEntity), workflowId);
            }

            using var snapshot = await _loader.LoadL1Async(new[] { workflowId }, c);

            // The start's locked order: cycle and missing step, schema edge, payload, liveness.
            var problems = new List<OrchestrationValidationException>();
            problems.AddRange(_cycles.Collect(snapshot));
            problems.AddRange(_schemaEdges.Collect(snapshot));
            problems.AddRange(_payloads.Collect(snapshot));
            try
            {
                problems.AddRange(await _liveness.CollectAsync(snapshot, c));
            }
            catch (RedisException ex)
            {
                // A transport fault is a tagged 500, never a "not live" problem.
                ex.Data["redisOp"] = "ValidateLiveness";
                throw;
            }

            return new WorkflowValidationDto(
                problems.Count == 0,
                problems.Select(p => new WorkflowProblemDto(p.Gate, p.Title, p.Message, p.Offending)).ToList());
        }, ct);
    }
}
