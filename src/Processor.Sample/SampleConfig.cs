using BaseProcessor.Core.Configuration;

namespace Processor.Sample;

/// <summary>
/// The author's config: whatever this processor needs from the step that invoked it. The framework
/// deserializes the step's payload into this before calling the transform, case-insensitively, so
/// <c>{"number":5,"label":"Step_A"}</c> binds.
/// </summary>
// `Label = null`: the record states the optionality it already behaves as. Nullability is a
// deserialization concern rather than a contract one, so the startup conformance check reads a
// parameter without a default as required -- and the registered row makes label optional.
public sealed record SampleConfig(int Number, string? Label = null) : ProcessorConfig;
