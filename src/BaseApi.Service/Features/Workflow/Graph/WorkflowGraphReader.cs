using System.Text.Json;
using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Orchestration.Loading;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// Reads a workflow's graph through the same <see cref="IWorkflowGraphLoader"/> the orchestrator's
/// start path uses, so the editor sees exactly the step set a start would see: everything reachable
/// from the entry steps over the next-step junction. Adds the layout, which the loader does not read.
/// </summary>
internal sealed class WorkflowGraphReader : IWorkflowGraphReader
{
    private readonly BaseDbContext _db;
    private readonly IWorkflowGraphLoader _loader;

    public WorkflowGraphReader(BaseDbContext db, IWorkflowGraphLoader loader)
    {
        _db = db ?? throw new ArgumentNullException(nameof(db));
        _loader = loader ?? throw new ArgumentNullException(nameof(loader));
    }

    public async Task<WorkflowGraphDto> ReadAsync(Guid workflowId, CancellationToken ct)
    {
        var row = await _db.Set<WorkflowEntity>().AsNoTracking()
            .Where(w => w.Id == workflowId)
            .Select(w => new { w.Layout })
            .FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException(nameof(WorkflowEntity), workflowId);

        JsonElement? layout = null;
        if (row.Layout is not null)
        {
            using var doc = JsonDocument.Parse(row.Layout);
            layout = doc.RootElement.Clone();
        }

        // The snapshot clears itself on dispose, so everything is copied out before it goes.
        using var snapshot = await _loader.LoadL1Async([workflowId], ct);

        // The workflow can be deleted between the two reads.
        if (!snapshot.Workflows.TryGetValue(workflowId, out var workflow))
            throw new NotFoundException(nameof(WorkflowEntity), workflowId);

        return new WorkflowGraphDto(
            workflow,
            snapshot.Steps.Values.OrderBy(s => s.Name, StringComparer.Ordinal).ThenBy(s => s.Id).ToList(),
            snapshot.Processors.Values.OrderBy(p => p.Name, StringComparer.Ordinal).ThenBy(p => p.Id).ToList(),
            snapshot.Schemas.Values.OrderBy(s => s.Name, StringComparer.Ordinal).ThenBy(s => s.Id).ToList(),
            snapshot.Assignments.Values.OrderBy(a => a.StepId).ThenBy(a => a.Id).ToList(),
            snapshot.Caches.Values.OrderBy(c => c.Name, StringComparer.Ordinal).ThenBy(c => c.Id).ToList(),
            layout);
    }
}
