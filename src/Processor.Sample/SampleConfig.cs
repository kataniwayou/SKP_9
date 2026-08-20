using BaseProcessor.Core.Configuration;

namespace Processor.Sample;

/// <summary>
/// The author's config: whatever this processor needs from the step that invoked it. The framework
/// deserializes the step's payload into this before calling the transform, case-insensitively, so
/// <c>{"number":5,"label":"Step_A"}</c> binds.
/// </summary>
public sealed record SampleConfig(int Number, string? Label) : ProcessorConfig;
