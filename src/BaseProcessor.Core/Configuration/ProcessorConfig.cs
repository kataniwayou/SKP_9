using System.Text.Json;

namespace BaseProcessor.Core.Configuration;

/// <summary>
/// The base every author config record derives from. It contributes no fields — it exists so the
/// framework has a type to constrain on, and so the config-schema check has something to reflect over.
/// </summary>
public abstract record ProcessorConfig
{
    /// <summary>
    /// The one deserialization contract for step payloads.
    /// <para>
    /// Case-insensitive, and unknown properties are ignored rather than rejected: a step payload is
    /// authored by whoever built the workflow, and a config gaining a field must not break every
    /// workflow that predates it. That tolerance is the opposite of the wire contract's — see
    /// <c>MessagingJson</c>, where a name that does not bind is a fault to catch, not a field to skip.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };
}
