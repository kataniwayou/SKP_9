using System.Text.Json;
using BaseApi.Service.Features.Workflow.Design;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Builders for design bodies, so a test states only the changes it cares about.</summary>
internal static class DesignBody
{
    public static JsonElement Layout(string json = """{"v":1}""") => JsonDocument.Parse(json).RootElement.Clone();

    public static Dictionary<string, JsonElement> F(string json) => JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    public static DesignSaveRequest Of(
        DesignWorkflowDto? workflow = null, DesignStepDto[]? steps = null, DesignProcessorDto[]? processors = null,
        DesignCacheDto[]? caches = null, DesignSchemaDto[]? schemas = null, DesignAssignmentDto[]? assignments = null,
        string layout = """{"v":1}""", DesignNewStepDto[]? newSteps = null, DesignNewCacheDto[]? newCaches = null,
        DesignDeleteDto[]? deletedSteps = null, DesignDeleteDto[]? deletedCaches = null, DesignNewWorkflowDto? newWorkflow = null) =>
        new(workflow, steps?.ToList(), processors?.ToList(), caches?.ToList(), schemas?.ToList(), assignments?.ToList(), Layout(layout),
            newSteps?.ToList(), newCaches?.ToList(), deletedSteps?.ToList(), deletedCaches?.ToList(), newWorkflow);

    /// <summary>An outcome's errors on one line each, for assertion messages.</summary>
    public static string Describe(DesignOutcomeDto o) =>
        string.Join("; ", o.Errors.Select(e => $"{e.Kind}/{e.Stage}/{e.Field}: {e.Message}"));
}
