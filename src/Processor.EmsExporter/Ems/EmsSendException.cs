namespace Processor.EmsExporter.Ems;

/// <summary>
/// The seam's one fault. The adapter translates every <c>TIBCO.EMS.EMSException</c> into this, so
/// the processor — and the tests — never reference a TIBCO type.
/// </summary>
/// <param name="code">
/// The EMS error code when the server gave one, or a short name for the local cause. It is what the
/// step's failure message carries; the inner exception keeps the rest.
/// </param>
public sealed class EmsSendException(string code, string message, Exception? inner = null)
    : Exception(message, inner)
{
    public string Code { get; } = code;
}
