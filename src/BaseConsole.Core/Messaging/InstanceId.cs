namespace BaseConsole.Core.Messaging;

/// <summary>
/// This processor replica's own identity, used to name its exclusive reply queue. A record rather
/// than a bare string so a DI container can resolve it as a constructor parameter — a bare
/// <see cref="string"/> parameter is ambiguous to a container and would fail to resolve at startup.
/// </summary>
public sealed record InstanceId(string Value)
{
    public string Value { get; init; } = Validated(Value);

    private static string Validated(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        return value;
    }
}
