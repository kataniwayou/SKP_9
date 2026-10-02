using BaseConsole.Core.Naming;

namespace BaseApi.Tests.Support;

internal sealed class FakeStepRoleSource(IReadOnlyDictionary<(Guid Workflow, Guid Step), string> roles) : IStepRoleSource
{
    public Task<string?> ReadRoleAsync(Guid workflowId, Guid stepId)
        => Task.FromResult(roles.TryGetValue((workflowId, stepId), out var r) ? r : null);
}
