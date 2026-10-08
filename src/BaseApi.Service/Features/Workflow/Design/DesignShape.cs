using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using FluentValidation.Results;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// The only checks that make a design a 400 (plan 8 §4.3): a body that is not a design at all. They
/// run before anything is stored; everything else is an entity error reported by the stages.
/// </summary>
internal static class DesignShape
{
    private static readonly string[] Slots = ["input", "output", "config"];
    private static readonly string[] Ops = ["create", "update", "delete"];

    public static void ThrowIfMalformed(Guid workflowId, DesignSaveRequest r)
    {
        var failures = new List<ValidationFailure>();
        void Fail(string property, string message) => failures.Add(new ValidationFailure(property, message));

        if (workflowId == Guid.Empty) Fail("WorkflowId", "The workflow id must not be Guid.Empty.");
        if (r.Layout is not { } layout) Fail(nameof(DesignSaveRequest.Layout), "Layout is required.");
        else if (WorkflowLayout.Validate(layout) is { } error) Fail(nameof(DesignSaveRequest.Layout), error);

        Unique(r.Steps?.Select(s => s.Id), nameof(DesignSaveRequest.Steps), Fail);
        Unique(r.Processors?.Select(p => p.Id), nameof(DesignSaveRequest.Processors), Fail);
        Unique(r.Caches?.Select(c => c.Id), nameof(DesignSaveRequest.Caches), Fail);
        Unique(r.Schemas?.Select(s => s.Id), nameof(DesignSaveRequest.Schemas), Fail);
        Unique(r.Assignments?.Select(a => a.Id), nameof(DesignSaveRequest.Assignments), Fail);
        Unique(r.Assignments?.Select(a => a.StepId), "Assignments.StepId", Fail);

        var copies = (r.Schemas ?? []).Select(s => s.Id).ToHashSet();
        foreach (var p in r.Processors ?? [])
            foreach (var (slot, schemaId) in p.Slots ?? new Dictionary<string, Guid>())
            {
                if (!Slots.Contains(slot)) Fail($"Processors[{p.Id}].Slots", $"'{slot}' is not input, output or config.");
                else if (!copies.Contains(schemaId)) Fail($"Processors[{p.Id}].Slots", $"The {slot} slot names a schema this design does not carry.");
            }

        foreach (var a in r.Assignments ?? [])
            if (!Ops.Contains(a.Op)) Fail($"Assignments[{a.Id}].Op", "Op must be create, update or delete.");

        if (failures.Count > 0) throw new ValidationException(failures);
    }

    private static void Unique(IEnumerable<Guid>? ids, string property, Action<string, string> fail)
    {
        var list = ids?.ToList() ?? [];
        if (list.Any(id => id == Guid.Empty)) fail(property, "An id must not be Guid.Empty.");
        if (list.Distinct().Count() != list.Count) fail(property, "Each id may appear once.");
    }
}
