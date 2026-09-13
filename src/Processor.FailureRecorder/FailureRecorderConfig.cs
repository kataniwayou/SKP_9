using BaseProcessor.Core.Configuration;

namespace Processor.FailureRecorder;

/// <summary>
/// The step payload, and it holds NOTHING. This is a marker, and it exists only because the type
/// system demands one: <c>BaseProcessor.ExecuteAsync</c> is <c>internal abstract</c>, so nothing
/// outside <c>BaseProcessor.Core</c> can derive from the non-generic base, and
/// <c>BaseProcessor{TConfig}</c> is the only door.
/// <para>
/// <b>There is nothing for a workflow author to choose.</b> Everything this processor records — the
/// correlation id, the execution id, the moment — arrives on the dispatch or from the clock. A
/// payload field could only ever restate or contradict one of them.
/// </para>
/// <para>
/// <b>Do not add a null check for this in the processor.</b> <c>ArchiveCollapser</c> is the
/// precedent: null is legal, <c>{}</c> is legal, and a payload left over from another step is legal,
/// because nothing reads it. <c>EveryPayloadIsAccepted</c> is what fails if this is ever "fixed"
/// into symmetry with the processors that do read one.
/// </para>
/// </summary>
public sealed record FailureRecorderConfig : ProcessorConfig;
