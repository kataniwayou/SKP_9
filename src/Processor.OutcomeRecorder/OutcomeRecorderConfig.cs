using BaseProcessor.Core.Configuration;

namespace Processor.OutcomeRecorder;

/// <summary>
/// The step payload: one optional note, and nothing else.
/// <para>
/// <b>The note is the only thing a workflow author chooses.</b> Everything else this processor
/// records — the correlation id, the execution id, the workflow/step/processor position, the
/// moment — arrives on the dispatch or from the clock. A payload field for any of them could only
/// ever restate or contradict one.
/// <para>
/// The outcome that dispatched this step cannot come from here either: a payload field would state
/// what the WORKFLOW wired rather than what the run did, and the two part company the moment a step
/// is reachable on more than one entry condition. See <c>OutcomeRecord</c>. A note is free text the
/// author writes for whoever reads the record; the recorder copies it and asserts nothing with it.
/// </para>
/// </para>
/// <para>
/// <b>Do not add a null check for this in the processor.</b> <c>ArchiveCollapser</c> is the
/// precedent: null is legal, <c>{}</c> is legal, and a payload left over from another step is legal.
/// The note is optional, so a payload without one is as valid as one with it.
/// <c>EveryPayloadIsAccepted</c> is what fails if this is ever "fixed" into symmetry with the
/// processors whose payload is required.
/// </para>
/// </summary>
/// <param name="Note">
/// Free text appended, exactly as written, to every record this step produces. Null, empty or
/// whitespace means no note, and the record then carries no <c>note</c> field at all.
/// </param>
public sealed record OutcomeRecorderConfig(string? Note = null) : ProcessorConfig;
