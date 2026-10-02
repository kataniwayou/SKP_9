namespace BaseConsole.Core.Naming;

/// <summary>Where a step's role in one workflow is read from. The L2 implementation is RedisStepRoleSource.</summary>
public interface IStepRoleSource
{
    /// <summary>The role, or null when the workflow's projection holds none for this step.</summary>
    Task<string?> ReadRoleAsync(Guid workflowId, Guid stepId);
}
