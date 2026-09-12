using BaseProcessor.Core.Configuration;

namespace Processor.SKNormalizer;

/// <summary>
/// The step payload, and it holds exactly one field.
/// <para>
/// <b>Everything else a provider needs is IN the handler</b> — that is the whole point of compiling
/// them in. A payload naming field maps or ffmpeg arguments would be a second, weaker place to
/// express what the handler already states in code, and the two would drift.
/// </para>
/// <para>
/// <b>The registered config schema declares this field with an <c>enum</c> of the handler names this
/// build carries</b>, so <c>PayloadConfigSchemaValidator</c> refuses a workflow naming an absent
/// handler AT PUBLISH — while the operator is still at the screen. The rejection in
/// <c>SKNormalizerProcessor</c> is the backstop, not the primary defence. The source text is
/// <c>src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json</c>.
/// </para>
/// <para>
/// <b>No default, and that is why the schema must REQUIRE it.</b>
/// <c>ConfigSchemaConformance</c> reads the presence of a default parameter value as the signal for
/// optionality — not nullability — so a positional parameter without one must appear in the schema's
/// <c>required</c> array or startup fails.
/// </para>
/// </summary>
public sealed record SKNormalizerConfig(string Handler) : ProcessorConfig;
