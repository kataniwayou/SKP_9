using System.Net.Sockets;
using BaseProcessor.Core.Processing;
using Xunit;

namespace BaseApi.Tests.Processor;

/// <summary>
/// A step failure has to be diagnosable after the fact.
/// <para>
/// The failure that prompted this: an analyst dispatch reported "the model backend could not be
/// reached" and nothing else. The <see cref="System.Net.Http.HttpRequestException"/> underneath — the
/// only thing distinguishing DNS from a refused connection from a TLS fault — was dropped when the
/// author translated it, so the Elasticsearch record carried no exception fields at all and the pod
/// holding the detail was rolled away hours later. The cause of that failure is now unknowable.
/// </para>
/// </summary>
public sealed class StepFailureCarriesItsCauseTests
{
    [Fact]
    public void AFailedExceptionKeepsTheCauseItWasGiven()
    {
        var cause = new SocketException(11001);   // host not found

        var failure = new FailedException("the model backend could not be reached", cause);

        Assert.Same(cause, failure.InnerException);
        Assert.Equal("the model backend could not be reached", failure.Message);
    }

    [Fact]
    public void ACancelledExceptionKeepsItsCauseToo()
    {
        var cause = new InvalidOperationException("underlying");

        Assert.Same(cause, new CancelledException("ended early", cause).InnerException);
    }

    [Fact]
    public void ACauseIsOptionalSoExistingAuthorsAreUnaffected()
    {
        // Every author that reports a business outcome with no exception behind it keeps compiling
        // and keeps meaning the same thing.
        var failure = new FailedException("no step payload; the Analyst cannot run without one");

        Assert.Null(failure.InnerException);
    }

    /// <summary>
    /// The chain the telemetry pipeline actually walks: it serialises the exception it is handed,
    /// including inner exceptions, which is how the working records elsewhere carry
    /// exception.type/message/stacktrace. Asserting the chain is intact is asserting the record will
    /// be.
    /// </summary>
    [Fact]
    public void TheCauseSurvivesTwoTranslations()
    {
        var root = new SocketException(10061);    // connection refused

        var middle = new InvalidOperationException("the model backend could not be reached", root);
        var reported = new FailedException(middle.Message, middle);

        Assert.Same(middle, reported.InnerException);
        Assert.Same(root, reported.InnerException!.InnerException);
    }
}
