using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Orchestration.Loading;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Workflow;
using FluentValidation;
using FluentValidation.Results;
using Microsoft.EntityFrameworkCore;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// The dry run behind <c>POST /workflows/{id}/validate</c>: load the stored workflow with the loader the
/// start path uses, collect every gate's problems in the start's locked order, and roll back.
/// <para>
/// <b>Liveness runs after the rollback.</b> Inside the dry run only the existence check, the
/// snapshot load and the three snapshot gates run. The liveness gate probes Redis once the transaction
/// is rolled back, so no row locks or pooled connection are held across Redis round trips. The snapshot
/// is in memory, so it outlives the transaction.
/// </para>
/// <para>
/// <b>Nothing escapes.</b> This never builds a start definition, never sends to the broker and never
/// writes Redis; its only Redis access is the read-only liveness probe. The reads run inside
/// <see cref="IGraphDryRun"/>, which always rolls back. (A draft body, saved with the graph saver inside the
/// dry run, went with WorkflowStudio on 2026-11-24.)
/// </para>
/// </summary>
internal sealed class WorkflowValidator : IWorkflowValidator
{
    private readonly BaseDbContext _db;
    private readonly IWorkflowGraphLoader _loader;
    private readonly CycleDetector _cycles;
    private readonly SchemaEdgeValidator _schemaEdges;
    private readonly PayloadConfigSchemaValidator _payloads;
    private readonly ProcessorLivenessValidator _liveness;
    private readonly IGraphDryRun _dryRun;

    public WorkflowValidator(
        BaseDbContext db,
        IWorkflowGraphLoader loader,
        CycleDetector cycles,
        SchemaEdgeValidator schemaEdges,
        PayloadConfigSchemaValidator payloads,
        ProcessorLivenessValidator liveness,
        IGraphDryRun dryRun)
    {
        _db = db;
        _loader = loader;
        _cycles = cycles;
        _schemaEdges = schemaEdges;
        _payloads = payloads;
        _liveness = liveness;
        _dryRun = dryRun;
    }

    public Task<WorkflowValidationDto> ValidateAsync(Guid workflowId, CancellationToken ct)
    {
        if (workflowId == Guid.Empty)
        {
            throw new ValidationException(new[] { new ValidationFailure(nameof(workflowId), "WorkflowId must not be Guid.Empty.") });
        }

        return ValidateCoreAsync(workflowId, ct);
    }

    private async Task<WorkflowValidationDto> ValidateCoreAsync(Guid workflowId, CancellationToken ct)
    {
        // Only the database work runs inside the dry-run transaction; it hands the in-memory snapshot
        // and the snapshot gates' problems out, and the liveness probe runs after the rollback.
        var (snapshot, problems) = await _dryRun.RunAsync(async c =>
        {
            if (!await _db.Set<WorkflowEntity>().AsNoTracking().AnyAsync(w => w.Id == workflowId, c))
            {
                throw new NotFoundException(nameof(WorkflowEntity), workflowId);
            }

            var loaded = await _loader.LoadL1Async(new[] { workflowId }, c);
            try
            {
                // The start's locked order: cycle and missing step, schema edge, payload, then liveness.
                var found = new List<OrchestrationValidationException>();
                found.AddRange(_cycles.Collect(loaded));
                found.AddRange(_schemaEdges.Collect(loaded));
                found.AddRange(_payloads.Collect(loaded));
                return (loaded, found);
            }
            catch
            {
                loaded.Dispose();
                throw;
            }
        }, ct);

        using (snapshot)
        {
            try
            {
                problems.AddRange(await _liveness.CollectAsync(snapshot, ct));
            }
            catch (RedisException ex)
            {
                // A transport fault is a tagged 500, never a "not live" problem.
                ex.Data["redisOp"] = "ValidateLiveness";
                throw;
            }
        }

        return new WorkflowValidationDto(
            problems.Count == 0,
            problems.Select(p => new WorkflowProblemDto(p.Gate, p.Title, p.Message, p.Offending)).ToList());
    }
}
