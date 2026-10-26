using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.ObjectPersister;

/// <summary>
/// The output contract: where the file was written. This is the WRITER's copy of the record
/// <c>FileFetcher.Locator</c> reads, and it is deliberately the same shape — the registered
/// <c>locator</c> row is ONE row, shared by this processor's output and <c>KafkaImporter</c>'s (and,
/// since 2026-10-26, by the object pair, whose locations are <c>s3://</c> URIs where these are
/// absolute paths: hence <c>location</c>, a name true of both).
/// <para>
/// <b>That sharing is the design, not a saving.</b> A record this processor emits reaches a Kafka
/// topic through <c>KafkaExporter</c> unchanged, and a record on a topic is what
/// <c>KafkaImporter</c> consumes. One shape on both ends means the output topic of this workflow is
/// a valid input topic for the next: the loop closes at the outermost layer, the same way
/// expander/collapser closes at the innermost.
/// </para>
/// <para>
/// <b>Non-nullable, unlike the reader's copy in FileFetcher.</b> A writer cannot emit a path it does
/// not have — the path is constructed here, from a folder this processor validated and a name it
/// checked, so there is no state in which it is absent.
/// </para>
/// </summary>
internal sealed record Locator(string Location);

/// <summary>The one serializer configuration for the locator record.</summary>
internal static class LocatorJson
{
    /// <summary>
    /// <b>camelCase, pinned explicitly</b>, for the reason <c>FetchedFileJson</c> gives: the
    /// messaging envelope's own options leave the naming policy null — PascalCase — and inheriting
    /// that convention here would emit <c>Location</c>, which the registered schema does not name.
    /// <para>
    /// No <c>DefaultIgnoreCondition</c> is needed and none is set: the record has one non-nullable
    /// property, so there is no null that could be omitted.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}
