using BaseApi.Core.DependencyInjection;
using BaseApi.Tests.Support;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Xunit;

namespace BaseApi.Tests.DependencyInjection;

/// <summary>
/// The problem-details customizer's refusal record.
/// <para>
/// <b>Asserted here rather than through an endpoint because here is where the guarantee lives.</b>
/// Five of the six exception handlers write no log line of their own, and the point of emitting from
/// the customizer is that a sixth handler added later inherits the record without doing anything. A
/// test that drove one endpoint would pin one handler and leave that property unpinned.
/// </para>
/// </summary>
public sealed class RefusalLoggingTests
{
    /// <summary>
    /// Runs the configured customizer against one emission and hands back what was logged.
    /// </summary>
    private static (IReadOnlyList<(LogLevel Level, string Message)> Records, ProblemDetails Problem)
        Emit(int status, string title)
    {
        var factory = new RecordingLoggerFactory();

        var app = new ServiceCollection();
        app.AddSingleton<ILoggerFactory>(factory);
        app.AddLogging();

        var services = new ServiceCollection();
        services.AddBaseApiErrorHandling();

        var customize = services.BuildServiceProvider()
            .GetRequiredService<IOptions<ProblemDetailsOptions>>()
            .Value.CustomizeProblemDetails;

        Assert.NotNull(customize);

        var http = new DefaultHttpContext { RequestServices = app.BuildServiceProvider() };
        http.Request.Path = "/api/v1/orchestration/start";
        http.Response.StatusCode = status;

        var problem = new ProblemDetails { Status = status, Title = title };

        customize(new ProblemDetailsContext { HttpContext = http, ProblemDetails = problem });

        return (factory.Records, problem);
    }

    [Fact]
    public void AnUnprocessableRequestIsRecordedAtWarning()
    {
        // The refusal that motivated this: OrchestrationService runs five gates and logs only
        // "accepted start", on success. A workflow refused because a processor is UNHEALTHY left no
        // server-side record at all, so it read exactly like a request that never arrived.
        var (records, _) = Emit(StatusCodes.Status422UnprocessableEntity, "processorLiveness");

        var record = Assert.Single(records);
        Assert.Equal(LogLevel.Warning, record.Level);
        Assert.Contains("refused with 422", record.Message, StringComparison.Ordinal);
        Assert.Contains("processorLiveness", record.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AConflictIsRecordedAtWarning()
    {
        // A lost concurrent write is work asked for and refused, the same as a failed gate.
        var (records, _) = Emit(StatusCodes.Status409Conflict, "Concurrency conflict");

        Assert.Equal(LogLevel.Warning, Assert.Single(records).Level);
    }

    [Fact]
    public void ANotFoundIsRecordedAtInformation()
    {
        // Information, deliberately. A caller probing for existence is not a fault, and this endpoint
        // set is polled — promoting it would make the level meaningless on the traffic that would
        // dominate it.
        var (records, _) = Emit(StatusCodes.Status404NotFound, "Not Found");

        Assert.Equal(LogLevel.Information, Assert.Single(records).Level);
    }

    [Fact]
    public void AServerFaultIsNotRecordedTwice()
    {
        // FallbackExceptionHandler already logs a 500 WITH the exception. A second record here would
        // double every unhandled fault and add nothing the first one does not carry.
        var (records, _) = Emit(StatusCodes.Status500InternalServerError, "An error occurred");

        Assert.Empty(records);
    }

    [Fact]
    public void TheCorrelationIdAndInstanceAreStillInjected()
    {
        // The customizer's original job, pinned because the refusal record was added inside it: a
        // throw or an early return in the new code would silently cost every emission its
        // correlation id, and no existing test covers that.
        var (_, problem) = Emit(StatusCodes.Status422UnprocessableEntity, "cycle");

        Assert.Equal("/api/v1/orchestration/start", problem.Instance);
    }

    /// <summary>
    /// An <see cref="ILoggerFactory"/> that records every write, whatever category it is asked for.
    /// <see cref="RecordingLogger{T}"/> cannot serve here: the refusal record is written to a named
    /// category rather than to a type's logger, which is the whole reason it is not tied to a handler.
    /// </summary>
    private sealed class RecordingLoggerFactory : ILoggerFactory
    {
        private readonly Recorded<(LogLevel Level, string Message)> _records = new();

        public IReadOnlyList<(LogLevel Level, string Message)> Records => _records;

        public ILogger CreateLogger(string categoryName) => new Sink(_records);

        public void AddProvider(ILoggerProvider provider) { }

        public void Dispose() { }

        private sealed class Sink(Recorded<(LogLevel Level, string Message)> records) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel level,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => records.Add((level, formatter(state, exception)));
        }
    }
}
