using System.Net;
using System.Text;
using System.Text.Json;
using Amazon.S3;
using Amazon.S3.Model;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using BaseProcessor.Core.Validation;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Processor.ObjectPersister;
using Xunit;

namespace BaseApi.Tests.ObjectPersister;

/// <summary>
/// The mirror of <c>FilePersisterTests</c>, against a substituted client: what comes OFF the wire
/// and goes into ONE <c>PUT</c>. The envelope and name-guard cases are the file pair's, case for
/// case; what is new is the destination, the missing-bucket reading, and the SDK fault mapping.
/// </summary>
public sealed class ObjectPersisterTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private const string Destination = """{"DestinationUri":"s3://skp-out/acme"}""";

    private readonly IAmazonS3 _s3 = Substitute.For<IAmazonS3>();
    private readonly IQueueSender _sender = Substitute.For<IQueueSender>();
    private readonly List<ProcessedData> _sends = [];
    private readonly RecordingLogger<ObjectPersisterProcessor> _logger = new();

    /// <summary>Every request the processor put, with the body read at the moment of the call.</summary>
    private readonly List<(PutObjectRequest Request, byte[] Body)> _puts = [];

    /// <summary>An envelope in exactly the shape FileFetcher and ObjectFetcher both emit.</summary>
    private static byte[] Envelope(
        string fileName, byte[] content, string? extension = null, bool omitContent = false)
    {
        var body = new Dictionary<string, object?>
        {
            ["fileName"] = fileName,
            ["extension"] = extension ?? Path.GetExtension(fileName),
            ["sizeBytes"] = content.Length,
            ["createdUtc"] = null,
            ["modifiedUtc"] = null,
        };

        if (!omitContent)
        {
            body["content"] = Convert.ToBase64String(content);
        }

        return JsonSerializer.SerializeToUtf8Bytes(body);
    }

    private ObjectPersisterProcessor Build()
    {
        _sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(_sends.Add),
                          Arg.Any<CancellationToken>(), Arg.Any<string?>());

        _s3.PutObjectAsync(Arg.Any<PutObjectRequest>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                var request = call.Arg<PutObjectRequest>();
                using var copy = new MemoryStream();
                request.InputStream.CopyTo(copy);
                _puts.Add((request, copy.ToArray()));
                return new PutObjectResponse();
            });

        var processor = new ObjectPersisterProcessor(_logger, _s3);
        processor.BeginDispatch(TestDispatch.State(_sender, C, W, S, P));
        return processor;
    }

    /// <summary>
    /// The raw call, so a test can pass a NULL step payload, which is a different case than a
    /// malformed one.
    /// </summary>
    private Task Run(
        byte[] envelope, string? payload = Destination, CancellationToken? ct = null)
        // payload! because the NULL case is exactly what one test here exercises: ExecuteAsync
        // declares it non-nullable, and the processor's own guard is what must answer for it.
        => Build().ExecuteAsync(envelope, payload!, E, ct ?? TestContext.Current.CancellationToken);

    private async Task<string> Failure(byte[] envelope, string? payload = Destination)
        => (await Assert.ThrowsAsync<FailedException>(() => Run(envelope, payload))).Message;

    /// <summary>Makes the PUT fail. Called after Build() would overwrite it, so it builds first.</summary>
    private ObjectPersisterProcessor BuildPutThrowing(Exception ex)
    {
        var processor = Build();
        _s3.PutObjectAsync(Arg.Any<PutObjectRequest>(), Arg.Any<CancellationToken>()).Throws(ex);
        return processor;
    }

    private async Task<string> FailureOf(Exception ex, byte[]? envelope = null)
    {
        var processor = BuildPutThrowing(ex);
        return (await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync(
                envelope ?? Envelope("orders.csv", [1]), Destination, E,
                TestContext.Current.CancellationToken))).Message;
    }

    private void NothingWasPut()
        => Assert.DoesNotContain(_s3.ReceivedCalls(), c => c.GetMethodInfo().Name == "PutObjectAsync");

    /// <summary>So a cancellation test proves the PUT threw, not that nothing ever ran.</summary>
    private void PutWasReached()
        => Assert.Contains(_s3.ReceivedCalls(), c => c.GetMethodInfo().Name == "PutObjectAsync");

    // ---- the write ----------------------------------------------------------------------------

    [Fact]
    public async Task TheBytesArePutUnderThePrefix()
    {
        await Run(Envelope("orders.csv", [1, 2, 3]));

        var (request, body) = Assert.Single(_puts);
        Assert.Equal("skp-out", request.BucketName);
        Assert.Equal("acme/orders.csv", request.Key);
        Assert.Equal<byte[]>([1, 2, 3], body);
    }

    [Fact]
    public async Task TheExtensionIsNotAppendedToTheName()
    {
        // THE REGRESSION THE FILE PAIR'S TEST OF THE SAME NAME EXISTS FOR: the envelope's fileName
        // already carries the extension, so a key built as prefix + name + extension would be
        // "orders.zip.zip".
        await Run(Envelope("orders.zip", [1, 2, 3]));

        Assert.Equal("acme/orders.zip", Assert.Single(_puts).Request.Key);
    }

    [Fact]
    public async Task ABucketRootDestinationPutsTheNameAlone()
    {
        await Run(Envelope("orders.csv", [1]), """{"DestinationUri":"s3://skp-out"}""");

        Assert.Equal("orders.csv", Assert.Single(_puts).Request.Key);
    }

    [Fact]
    public async Task AZeroByteFileIsWritten()
    {
        // A zero-byte file is a file; FileFetcher and ObjectFetcher both admit one.
        await Run(Envelope("empty.csv", []));

        var (request, body) = Assert.Single(_puts);
        Assert.Equal("acme/empty.csv", request.Key);
        Assert.Empty(body);
    }

    [Theory]
    [InlineData("a b+ü.csv")]
    [InlineData("a%20b.csv")] // a literal %20 is not decoded to a space, on the wire or in the report
    public async Task ANameWithSpacesAndUnicodeIsWrittenAndReportedVerbatim(string name)
    {
        await Run(Envelope(name, [1]));

        Assert.Equal($"acme/{name}", Assert.Single(_puts).Request.Key);
        using var doc = JsonDocument.Parse(Assert.Single(_sends).Data);
        Assert.Equal($"s3://skp-out/acme/{name}", doc.RootElement.GetProperty("location").GetString());
    }

    [Fact]
    public async Task EveryCallReceivesTheDispatchToken()
    {
        using var cts = new CancellationTokenSource();

        await Run(Envelope("orders.csv", [1]), ct: cts.Token);

        var call = Assert.Single(_s3.ReceivedCalls(), c => c.GetMethodInfo().Name == "PutObjectAsync");
        Assert.Equal(cts.Token, call.GetArguments()[1]);
    }

    // ---- the branch ---------------------------------------------------------------------------

    [Fact]
    public async Task OneBranchIsSentOnTheDispatchsOwnExecutionId()
    {
        // A transform, not a source: the lineage it was handed is the lineage it continues.
        await Run(Envelope("orders.csv", [1]));

        Assert.Equal(E, Assert.Single(_sends).ExecutionId);
    }

    [Fact]
    public async Task TheLocationNamesWhatWasWritten()
    {
        await Run(Envelope("orders.csv", [1, 2, 3]));

        using var doc = JsonDocument.Parse(Assert.Single(_sends).Data);
        var prop = Assert.Single(doc.RootElement.EnumerateObject());
        Assert.Equal("location", prop.Name);
        Assert.Equal("s3://skp-out/acme/orders.csv", prop.Value.GetString());
    }

    [Fact]
    public async Task TheLocatorValidatesAgainstTheRegisteredSchema()
    {
        // The SAME validator the post handler runs, against the same locator.json the file pair's
        // output is checked with.
        await Run(Envelope("orders.csv", [1]));

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "locator.json")),
            Assert.Single(_sends).Data,
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public async Task TheLogLineIsTheFilePersistersTemplate()
    {
        await Run(Envelope("orders.csv", [1, 2, 3]));

        var record = Assert.Single(_logger.Records);
        Assert.Equal(
            "persisted orders.csv (.csv), 3 bytes, to s3://skp-out/acme/orders.csv", record.Message);
    }

    // ---- payload faults -----------------------------------------------------------------------

    [Fact]
    public async Task AnAbsentPayloadIsRejected()
    {
        var message = await Failure(Envelope("orders.csv", [1]), payload: null);

        Assert.StartsWith("step payload rejected:", message, StringComparison.Ordinal);
        Assert.Contains("DestinationUri", message, StringComparison.Ordinal);
        NothingWasPut();
    }

    [Theory]
    [InlineData("""{"DestinationUri":""}""")]
    [InlineData("""{}""")]
    [InlineData("""{"DestinationUri":"s3://Bad_Bucket/x"}""")]
    public async Task AMalformedDestinationIsARejectedPayload(string payload)
    {
        var message = await Failure(Envelope("orders.csv", [1]), payload);

        Assert.StartsWith("step payload rejected:", message, StringComparison.Ordinal);
        NothingWasPut();
    }

    [Fact]
    public async Task ANonS3DestinationIsAPayloadFault()
    {
        var message = await Failure(
            Envelope("orders.csv", [1]), """{"DestinationUri":"/mnt/skp-files/out"}""");

        Assert.StartsWith("step payload rejected:", message, StringComparison.Ordinal);
        NothingWasPut();
    }

    // ---- envelope faults ----------------------------------------------------------------------

    [Fact]
    public async Task AnEnvelopeThatIsNotJsonIsDiagnosedWithoutQuotingIt()
    {
        var message = await Failure(Encoding.UTF8.GetBytes("{not json at all"));

        Assert.StartsWith("input branch did not carry a file:", message, StringComparison.Ordinal);
        Assert.Contains("the branch is not JSON", message, StringComparison.Ordinal);
        // The fragment that failed to parse is upstream content and must not reach a log store.
        Assert.DoesNotContain("not json at all", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEnvelopeWithNoContentIsRejected()
    {
        var message = await Failure(Envelope("orders.csv", [1], omitContent: true));

        Assert.StartsWith("input branch did not carry a file:", message, StringComparison.Ordinal);
        Assert.Contains("carries no content", message, StringComparison.Ordinal);
        NothingWasPut();
    }

    [Fact]
    public async Task AnEnvelopeWithNoFileNameIsRejected()
    {
        var message = await Failure(Envelope("", [1], extension: ".csv"));

        Assert.StartsWith("input branch did not carry a file:", message, StringComparison.Ordinal);
        Assert.Contains("carries no fileName", message, StringComparison.Ordinal);
        NothingWasPut();
    }

    // ---- the name guard -----------------------------------------------------------------------

    [Theory]
    [InlineData("../escape.csv")]
    [InlineData("..\\escape.csv")]
    [InlineData("sub/orders.csv")]
    [InlineData("sub\\orders.csv")]
    [InlineData("..")]
    public async Task AFileNameThatNamesADirectoryIsRejectedAndNothingIsWritten(string name)
    {
        // In S3 a "/" in the name would not escape a directory; it would silently write under a
        // different prefix. The rule that prevents both is the same rule.
        var message = await Failure(Envelope(name, [1]));

        Assert.StartsWith($"file name '{name}' rejected:", message, StringComparison.Ordinal);
        Assert.Contains("names a directory", message, StringComparison.Ordinal);
        NothingWasPut();
    }

    [Fact]
    public async Task AKeyOverTheLimitIsRejected()
    {
        // The name alone is 1024 bytes; with the "acme/" prefix the key is over.
        var name = new string('a', 1020) + ".csv";

        var message = await Failure(Envelope(name, [1]));

        Assert.StartsWith("file name '", message, StringComparison.Ordinal);
        Assert.Contains("1024", message, StringComparison.Ordinal);
        NothingWasPut();
    }

    [Fact]
    public async Task TheKeyLimitCountsUtf8BytesNotCharacters()
    {
        // 300 three-byte characters plus the prefix and extension: 909 bytes, under the limit.
        // 400 of them is 400 characters but 1209 bytes, over it.
        await Run(Envelope(new string('€', 300) + ".csv", [1]));
        Assert.Single(_puts);

        var message = await Failure(Envelope(new string('€', 400) + ".csv", [1]));
        Assert.Contains("1024", message, StringComparison.Ordinal);
    }

    // ---- S3 faults ----------------------------------------------------------------------------

    [Fact]
    public async Task AMissingBucketIsAPayloadFault()
    {
        var message = await FailureOf(new AmazonS3Exception("The specified bucket does not exist")
        {
            ErrorCode = "NoSuchBucket",
            StatusCode = HttpStatusCode.NotFound,
        });

        Assert.Equal(
            "step payload rejected: bucket 'skp-out' does not exist; this processor does not create it",
            message);
        Assert.DoesNotContain(_s3.ReceivedCalls(), c => c.GetMethodInfo().Name == "HeadBucketAsync");
    }

    [Fact]
    public async Task AForbiddenWriteFails()
    {
        var message = await FailureOf(
            new AmazonS3Exception("Access Denied") { StatusCode = HttpStatusCode.Forbidden });

        Assert.Equal("writing s3://skp-out/acme/orders.csv failed: access denied", message);
    }

    [Fact]
    public async Task ACodedForbiddenWriteCarriesItsCode()
    {
        var message = await FailureOf(new AmazonS3Exception("The request signature we calculated does not match.")
        {
            StatusCode = HttpStatusCode.Forbidden,
            ErrorCode = "SignatureDoesNotMatch",
        });

        Assert.Equal(
            "writing s3://skp-out/acme/orders.csv failed: SignatureDoesNotMatch: "
            + "The request signature we calculated does not match.",
            message);
    }

    [Fact]
    public async Task AnAccessDeniedCodeReadsAsAccessDenied()
    {
        var message = await FailureOf(new AmazonS3Exception("Access Denied")
        {
            StatusCode = HttpStatusCode.Forbidden,
            ErrorCode = "AccessDenied",
        });

        Assert.Equal("writing s3://skp-out/acme/orders.csv failed: access denied", message);
    }

    [Fact]
    public async Task AnyOtherFaultCarriesTheSdksMessage()
    {
        var message = await FailureOf(new AmazonS3Exception("Please reduce your request rate.")
        {
            StatusCode = HttpStatusCode.ServiceUnavailable,
        });

        Assert.Equal(
            "writing s3://skp-out/acme/orders.csv failed: Please reduce your request rate.", message);
    }

    [Fact]
    public async Task ACancelledDispatchIsNotAFailedStep()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var processor = BuildPutThrowing(new OperationCanceledException(cts.Token));

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => processor.ExecuteAsync(Envelope("orders.csv", [1]), Destination, E, cts.Token));
        PutWasReached();
    }

    [Fact]
    public async Task AFaultSurfacingOnACancelledDispatchIsStillNotAFailedStep()
    {
        // A shutdown can reach the SDK as something other than an OperationCanceledException (a
        // socket closed under it). With the dispatch token cancelled, whatever surfaced is the
        // shutdown, not a fault in the step.
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var processor = BuildPutThrowing(
            new AmazonS3Exception("connection closed") { StatusCode = HttpStatusCode.ServiceUnavailable });

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => processor.ExecuteAsync(Envelope("orders.csv", [1]), Destination, E, cts.Token));
        PutWasReached();
    }

    [Fact]
    public async Task AnSdkTimeoutWhileTheDispatchIsLiveIsAFailedStep()
    {
        // The SDK surfaces its own Timeout as a TaskCanceledException. The dispatch token is not
        // cancelled, so this is a wedged endpoint, not a shutdown.
        var message = await FailureOf(
            new TaskCanceledException("The request was canceled due to the configured timeout."));

        Assert.Equal("writing s3://skp-out/acme/orders.csv failed: timed out", message);
    }
}
