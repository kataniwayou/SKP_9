namespace BaseApi.Core.Configuration;

/// <summary>
/// Redis projection options, bound to the <c>"Redis:*"</c> configuration section. There is
/// deliberately no key-prefix property — the L2 key prefix is a compile-time const on
/// <c>L2ProjectionKeys</c> — and no connection-string property, since the connection string comes
/// from <c>IConfiguration.GetConnectionString("Redis")</c>.
/// </summary>
public sealed class RedisProjectionOptions
{
    /// <summary>Processor-key TTL in days. Every start re-sets processor keys with this expiry.
    /// A value of zero or less means no expiry.</summary>
    public int ProcessorKeyTtlDays { get; set; } = 100;

    /// <summary>Nested serialization options.</summary>
    public SerializationOptions Serialization { get; set; } = new();

    public sealed class SerializationOptions
    {
        public string JsonOptions { get; set; } = "default";
    }
}
