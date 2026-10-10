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

        // a JSON null inside a list: every check below reads the elements, so it stops here
        NoNulls(r.Steps, nameof(DesignSaveRequest.Steps), Fail);
        NoNulls(r.Processors, nameof(DesignSaveRequest.Processors), Fail);
        NoNulls(r.Caches, nameof(DesignSaveRequest.Caches), Fail);
        NoNulls(r.Schemas, nameof(DesignSaveRequest.Schemas), Fail);
        NoNulls(r.Assignments, nameof(DesignSaveRequest.Assignments), Fail);
        NoNulls(r.NewSteps, nameof(DesignSaveRequest.NewSteps), Fail);
        NoNulls(r.NewCaches, nameof(DesignSaveRequest.NewCaches), Fail);
        NoNulls(r.DeletedSteps, nameof(DesignSaveRequest.DeletedSteps), Fail);
        NoNulls(r.DeletedCaches, nameof(DesignSaveRequest.DeletedCaches), Fail);
        if (failures.Count > 0) throw new ValidationException(failures);

        Unique(r.Steps?.Select(s => s.Id), nameof(DesignSaveRequest.Steps), Fail);
        Unique(r.Processors?.Select(p => p.Id), nameof(DesignSaveRequest.Processors), Fail);
        Unique(r.Caches?.Select(c => c.Id), nameof(DesignSaveRequest.Caches), Fail);
        Unique(r.Schemas?.Select(s => s.Id), nameof(DesignSaveRequest.Schemas), Fail);
        Unique(r.Assignments?.Select(a => a.Id), nameof(DesignSaveRequest.Assignments), Fail);
        Unique(r.Assignments?.Select(a => a.StepId), "Assignments.StepId", Fail);
        // a step (a cache) is created, changed or deleted, never two of them in one design
        Unique(Ids(r.NewSteps?.Select(s => s.Id), r.Steps?.Select(s => s.Id), r.DeletedSteps?.Select(s => s.Id)),
            "NewSteps, Steps and DeletedSteps", Fail);
        Unique(Ids(r.NewCaches?.Select(c => c.Id), r.Caches?.Select(c => c.Id), r.DeletedCaches?.Select(c => c.Id)),
            "NewCaches, Caches and DeletedCaches", Fail);
        foreach (var s in r.NewSteps ?? [])
        {
            // no processor (null or empty) is not a malformed request: the steps stage refuses that step (2026-10-10)
            if (s.CopyOf == Guid.Empty) Fail($"NewSteps[{s.Id}].CopyOf", "CopyOf must not be Guid.Empty.");
        }
        foreach (var c in r.NewCaches ?? [])
            if (c.CopyOf == Guid.Empty) Fail($"NewCaches[{c.Id}].CopyOf", "CopyOf must not be Guid.Empty.");
        foreach (var a in r.Assignments ?? [])
            if (a.CopyOf == Guid.Empty) Fail($"Assignments[{a.Id}].CopyOf", "CopyOf must not be Guid.Empty.");

        var copies = (r.Schemas ?? []).Select(s => s.Id).ToHashSet();
        foreach (var p in r.Processors ?? [])
        {
            // Hoisted out of the foreach header: `x ?? new Dictionary<,>()` directly in a deconstructing
            // foreach crashes the IDE0028 analyzer in SDK 8.0.4xx (AD0001), which fails the Release build.
            var slots = p.Slots ?? new Dictionary<string, Guid>();
            foreach (var (slot, schemaId) in slots)
            {
                if (!Slots.Contains(slot)) Fail($"Processors[{p.Id}].Slots", $"'{slot}' is not input, output or config.");
                else if (!copies.Contains(schemaId)) Fail($"Processors[{p.Id}].Slots", $"The {slot} slot names a schema this design does not carry.");
            }
        }

        foreach (var a in r.Assignments ?? [])
            if (!Ops.Contains(a.Op)) Fail($"Assignments[{a.Id}].Op", "Op must be create, update or delete.");

        if (failures.Count > 0) throw new ValidationException(failures);
    }

    private static IEnumerable<Guid> Ids(params IEnumerable<Guid>?[] lists) => lists.SelectMany(l => l ?? []);

    private static void NoNulls<T>(List<T>? items, string property, Action<string, string> fail) where T : class
    {
        if (items is null) return;
        for (var i = 0; i < items.Count; i++)
            if (items[i] is null) fail($"{property}[{i}]", $"{property}[{i}] must not be null.");
    }

    private static void Unique(IEnumerable<Guid>? ids, string property, Action<string, string> fail)
    {
        var list = ids?.ToList() ?? [];
        if (list.Any(id => id == Guid.Empty)) fail(property, "An id must not be Guid.Empty.");
        if (list.Distinct().Count() != list.Count) fail(property, "Each id may appear once.");
    }
}
