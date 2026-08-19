using Xunit;

namespace BaseApi.Tests.Support;

/// <summary>
/// Tests that mutate process-wide environment variables share this collection so xunit serialises
/// them. Without it two classes setting POD_NAME concurrently would race, and the failure would look
/// like a precedence bug rather than a test-isolation one.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class EnvironmentCollection
{
    public const string Name = "environment-variables";
}
