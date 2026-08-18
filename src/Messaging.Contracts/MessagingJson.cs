using System.Text.Json;
using System.Text.Json.Serialization;

namespace Messaging.Contracts;

/// <summary>
/// The single serializer configuration shared by every producer and consumer on the bus.
/// <para>
/// <b>Why this exists at all:</b> with the broker client used directly there is no framework
/// envelope and no framework serializer, so the wire shape is entirely ours. A producer and a
/// consumer that construct their own <see cref="JsonSerializerOptions"/> will agree right up until
/// one of them is edited — and the failure is silent, because a property that does not bind
/// deserializes to its default rather than throwing. One shared instance removes that class of drift.
/// </para>
/// <para>
/// <b>The settings are load-bearing, not stylistic.</b> Property naming is left at the .NET default
/// (PascalCase on the wire) because the L2 projection records already pin their own names with
/// explicit <c>[JsonPropertyName]</c> attributes; introducing a camelCase policy here would rename
/// every property that does <i>not</i> carry one, silently splitting the two conventions across a
/// single payload. <see cref="JsonNumberHandling.Strict"/> keeps a quoted number a hard error rather
/// than a tolerated one, so a malformed producer is caught by the deterministic branch and parked
/// instead of being half-understood.
/// </para>
/// </summary>
public static class MessagingJson
{
    /// <summary>The shared options instance. Immutable once first used by a serializer call.</summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = null,
        PropertyNameCaseInsensitive = false,
        NumberHandling = JsonNumberHandling.Strict,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}
