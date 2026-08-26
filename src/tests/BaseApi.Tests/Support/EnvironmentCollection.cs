using Xunit;

namespace BaseApi.Tests.Support;

/// <summary>
/// Tests that mutate process-wide environment variables share this collection so xunit serialises
/// them. Without it two classes setting POD_NAME concurrently would race, and the failure would look
/// like a precedence bug rather than a test-isolation one.
/// <para>
/// <b>Static metric instruments are the second kind of process-wide state this serialises.</b> A
/// <c>Meter</c> and its instruments are static and outlive any one test, and <c>MetricCollector</c>
/// filters by meter NAME rather than by the provider that produced a measurement -- so two classes
/// asserting on the same instrument concurrently see each other's measurements. A test asserting an
/// exact measurement sequence belongs here; one that isolates itself with a tag value nothing else
/// emits does not.
/// </para>
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class EnvironmentCollection
{
    public const string Name = "environment-variables";
}
