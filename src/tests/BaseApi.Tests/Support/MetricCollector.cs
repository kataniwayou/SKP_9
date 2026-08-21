using System.Collections.Concurrent;
using System.Diagnostics.Metrics;

namespace BaseApi.Tests.Support;

/// <summary>
/// One measurement as the listener saw it, with tag values flattened to strings so an assertion
/// reads as a dictionary lookup rather than a cast.
/// </summary>
public sealed record RecordedMeasurement(
    string Instrument, double Value, IReadOnlyDictionary<string, string> Tags);

/// <summary>
/// Subscribes to instruments by meter name and records every measurement they publish.
/// <para>
/// A <see cref="MeterListener"/> rather than an OpenTelemetry provider: the SDK aggregates, which
/// would hide exactly the property most of these tests assert — that a counter was incremented
/// once and not twice.
/// </para>
/// <para>
/// Instruments are static, so they outlive any single test. That is safe here because a listener
/// only sees measurements published while it is subscribed, and each test constructs its own.
/// </para>
/// </summary>
public sealed class MetricCollector : IDisposable
{
    private readonly MeterListener _listener = new();
    private readonly ConcurrentQueue<RecordedMeasurement> _measurements = new();
    private readonly HashSet<string> _meters;

    public MetricCollector(params string[] meterNames)
    {
        _meters = new HashSet<string>(meterNames, StringComparer.Ordinal);

        _listener.InstrumentPublished = (instrument, listener) =>
        {
            if (_meters.Contains(instrument.Meter.Name))
            {
                listener.EnableMeasurementEvents(instrument);
            }
        };

        _listener.SetMeasurementEventCallback<long>(
            (instrument, value, tags, _) => Add(instrument, value, tags));
        _listener.SetMeasurementEventCallback<int>(
            (instrument, value, tags, _) => Add(instrument, value, tags));
        _listener.SetMeasurementEventCallback<double>(
            (instrument, value, tags, _) => Add(instrument, value, tags));

        _listener.Start();
    }

    /// <summary>Every measurement seen so far, in the order it was published.</summary>
    public IReadOnlyList<RecordedMeasurement> Measurements => _measurements.ToArray();

    /// <summary>Just the measurements for one instrument name.</summary>
    public IReadOnlyList<RecordedMeasurement> For(string instrument) =>
        Measurements.Where(m => m.Instrument == instrument).ToArray();

    /// <summary>
    /// Polls every observable instrument. Observables publish nothing until asked, so a gauge
    /// assertion that skips this sees an empty list.
    /// </summary>
    public void Collect() => _listener.RecordObservableInstruments();

    private void Add<T>(
        System.Diagnostics.Metrics.Instrument instrument,
        T value,
        ReadOnlySpan<KeyValuePair<string, object?>> tags)
        where T : struct
    {
        var flattened = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var tag in tags)
        {
            flattened[tag.Key] = tag.Value?.ToString() ?? "";
        }

        _measurements.Enqueue(new RecordedMeasurement(
            instrument.Name, Convert.ToDouble(value), flattened));
    }

    public void Dispose() => _listener.Dispose();
}
