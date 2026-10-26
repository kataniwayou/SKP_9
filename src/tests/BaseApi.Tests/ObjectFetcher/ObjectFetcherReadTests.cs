using System.Net;
using System.Text;
using System.Text.Json;
using Amazon.S3;
using Amazon.S3.Model;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Processor.ObjectFetcher;
using Xunit;

namespace BaseApi.Tests.ObjectFetcher;

/// <summary>
/// The inspection and the read, against a substituted client. The properties that matter: nothing is
/// downloaded for an object that fails a check, the download is conditional on what was inspected,
/// every S3 fault is a failed step with the exact sentence an operator searches, and a cancelled
/// dispatch is not a fault.
/// </summary>
public sealed class ObjectFetcherReadTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private static readonly DateTime Stamp = new(2026, 9, 10, 8, 31, 2, DateTimeKind.Utc);

    private const string Location = "s3://skp-in/feeds/orders.csv";

    private const string CsvPayload =
        """{"AllowedExtensions":[".csv"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""";

    private readonly IAmazonS3 _s3 = Substitute.For<IAmazonS3>();
    private readonly IQueueSender _sender = Substitute.For<IQueueSender>();
    private readonly List<ProcessedData> _sends = [];
    private readonly RecordingLogger<ObjectFetcherProcessor> _logger = new();

    private ObjectFetcherProcessor Build()
    {
        _sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(_sends.Add),
                          Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var processor = new ObjectFetcherProcessor(
            _logger, Options.Create(new ObjectFetcherOptions()), _s3);
        processor.BeginDispatch(TestDispatch.State(_sender, C, W, S, P));
        return processor;
    }

    private void Head(long length, string etag = "\"abc\"")
        => _s3.GetObjectMetadataAsync(Arg.Any<GetObjectMetadataRequest>(), Arg.Any<CancellationToken>())
            .Returns(new GetObjectMetadataResponse
            {
                ContentLength = length,
                ETag = etag,
                LastModified = Stamp,
            });

    private void Body(byte[] body)
        => _s3.GetObjectAsync(Arg.Any<GetObjectRequest>(), Arg.Any<CancellationToken>())
            .Returns(_ => new GetObjectResponse { ResponseStream = new MemoryStream(body) });

    private void HeadThrows(Exception ex)
        => _s3.GetObjectMetadataAsync(Arg.Any<GetObjectMetadataRequest>(), Arg.Any<CancellationToken>())
            .Throws(ex);

    private static AmazonS3Exception Fault(HttpStatusCode status, string message = "boom")
        => new(message) { StatusCode = status };

    private Task Run(string location = Location, string payload = CsvPayload, CancellationToken? ct = null)
        => Build().ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { location })), payload, E,
            ct ?? TestContext.Current.CancellationToken);

    private async Task<string> Failure(string location = Location, string payload = CsvPayload)
        => (await Assert.ThrowsAsync<FailedException>(() => Run(location, payload))).Message;

    private T SentRequest<T>(string method) where T : class
        => (T)Assert.Single(_s3.ReceivedCalls(), c => c.GetMethodInfo().Name == method).GetArguments()[0]!;

    private void NeverDownloaded()
        => Assert.DoesNotContain(_s3.ReceivedCalls(), c => c.GetMethodInfo().Name == "GetObjectAsync");

    [Fact]
    public async Task TheObjectIsInspectedThenReadWithItsETag()
    {
        Head(7);
        Body(Encoding.UTF8.GetBytes("id,name"));

        await Run();

        Assert.Single(_sends);
        var request = SentRequest<GetObjectRequest>("GetObjectAsync");
        Assert.Equal("skp-in", request.BucketName);
        Assert.Equal("feeds/orders.csv", request.Key);
        Assert.Equal("\"abc\"", request.EtagToMatch);
    }

    [Fact]
    public async Task OneBranchIsSentOnTheDispatchsOwnExecutionId()
    {
        Head(7);
        Body(Encoding.UTF8.GetBytes("id,name"));

        await Run();

        Assert.Equal(E, Assert.Single(_sends).ExecutionId);
    }

    [Fact]
    public async Task TheEnvelopeCarriesTheObjectsIdentity()
    {
        Head(7);
        Body(Encoding.UTF8.GetBytes("id,name"));

        await Run();

        using var doc = JsonDocument.Parse(Assert.Single(_sends).Data);
        var root = doc.RootElement;

        Assert.Equal("orders.csv", root.GetProperty("fileName").GetString());
        Assert.Equal(".csv", root.GetProperty("extension").GetString());
        Assert.Equal(7, root.GetProperty("sizeBytes").GetInt64());
        // Present and null: S3 records no creation time, and the schema requires the key.
        Assert.Equal(JsonValueKind.Null, root.GetProperty("createdUtc").ValueKind);
        Assert.Equal(Stamp, root.GetProperty("modifiedUtc").GetDateTime().ToUniversalTime());
        Assert.Equal("id,name", Encoding.UTF8.GetString(root.GetProperty("content").GetBytesFromBase64()));
        Assert.False(root.TryGetProperty("location", out _));
    }

    [Fact]
    public async Task TheSuccessLineHasFileFetchersShapeAndNoLocation()
    {
        Head(7);
        Body(Encoding.UTF8.GetBytes("id,name"));

        await Run();

        var record = Assert.Single(_logger.Records);
        Assert.StartsWith("fetched orders.csv (.csv), 7 bytes, modified ", record.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("skp-in", record.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ADotlessKeyHasAnEmptyExtension()
    {
        Head(2);
        Body("ok"u8.ToArray());

        await Run("s3://skp-in/feeds/README", payload: """{"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""");

        using var doc = JsonDocument.Parse(Assert.Single(_sends).Data);
        Assert.Equal("README", doc.RootElement.GetProperty("fileName").GetString());
        Assert.Equal("", doc.RootElement.GetProperty("extension").GetString());
    }

    [Fact]
    public async Task AnyExtensionIsAdmittedUnderTheWildcard()
    {
        Head(2);
        Body("ok"u8.ToArray());

        await Run("s3://skp-in/report.pdf",
                  """{"AllowedExtensions":["*.*"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""");

        Assert.Single(_sends);
    }

    [Fact]
    public async Task AnOmittedExtensionListAdmitsEverything()
    {
        Head(2);
        Body("ok"u8.ToArray());

        await Run("s3://skp-in/report.pdf", """{"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""");

        Assert.Single(_sends);
    }

    [Fact]
    public async Task ARejectedExtensionIsNeverDownloaded()
    {
        Head(7);

        var message = await Failure("s3://skp-in/x.dat",
            """{"AllowedExtensions":[".zip"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""");

        Assert.Equal(
            "object s3://skp-in/x.dat rejected: extension '.dat' is not in the allowed list (.zip)", message);
        NeverDownloaded();
    }

    [Fact]
    public async Task ARejectedSizeIsNeverDownloaded()
    {
        Head(5000);

        var message = await Failure();

        Assert.StartsWith($"object {Location} rejected: ", message, StringComparison.Ordinal);
        Assert.Contains("5000 bytes is above the 4096 byte ceiling", message, StringComparison.Ordinal);
        NeverDownloaded();
    }

    [Fact]
    public async Task AnObjectBelowTheFloorIsRejectedAndNeverDownloaded()
    {
        Head(10);

        var message = await Failure(payload:
            """{"AllowedExtensions":[".csv"],"MinimumSizeBytes":100,"MaximumSizeBytes":4096}""");

        Assert.StartsWith($"object {Location} rejected: ", message, StringComparison.Ordinal);
        Assert.Contains("10 bytes is below the 100 byte floor", message, StringComparison.Ordinal);
        NeverDownloaded();
    }

    [Fact]
    public async Task AMissingObjectFails()
    {
        HeadThrows(Fault(HttpStatusCode.NotFound));

        var message = await Failure("s3://skp-in/x.zip",
            """{"AllowedExtensions":[".zip"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""");

        Assert.Equal("reading s3://skp-in/x.zip failed: it does not exist (bucket or key)", message);
    }

    [Fact]
    public async Task AForbiddenObjectFails()
    {
        HeadThrows(Fault(HttpStatusCode.Forbidden));

        var message = await Failure();

        Assert.Equal($"reading {Location} failed: access denied", message);
    }

    [Fact]
    public async Task AReplacedObjectFails()
    {
        Head(7);
        _s3.GetObjectAsync(Arg.Any<GetObjectRequest>(), Arg.Any<CancellationToken>())
            .Throws(Fault(HttpStatusCode.PreconditionFailed));

        var message = await Failure();

        Assert.Equal($"reading {Location} failed: it changed between inspection and read", message);
    }

    [Fact]
    public async Task ATruncatedBodyFails()
    {
        Head(10);
        Body(new byte[4]);

        var message = await Failure();

        Assert.Equal($"reading {Location} failed: the body ended after 4 of 10 bytes", message);
        Assert.Empty(_sends);
    }

    [Fact]
    public async Task AnOverlongBodyFails()
    {
        // The buffer is exactly the reported length; a longer body fails the step rather than
        // growing it.
        Head(4);
        Body(new byte[10]);

        var message = await Failure();

        Assert.Equal($"reading {Location} failed: the body ran past the reported 4 bytes", message);
        Assert.Empty(_sends);
    }

    [Fact]
    public async Task AnotherS3FaultCarriesTheSdkMessageAndNotItsStack()
    {
        HeadThrows(Fault(HttpStatusCode.ServiceUnavailable, "Please reduce your request rate."));

        var message = await Failure();

        Assert.Equal($"reading {Location} failed: Please reduce your request rate.", message);
    }

    [Fact]
    public async Task ATransportFaultIsAFailedStep()
    {
        Head(7);
        _s3.GetObjectAsync(Arg.Any<GetObjectRequest>(), Arg.Any<CancellationToken>())
            .Throws(new HttpRequestException("connection reset"));

        var message = await Failure();

        Assert.Equal($"reading {Location} failed: connection reset", message);
    }

    [Fact]
    public async Task AKeyIsSentVerbatim()
    {
        Head(7);
        Body(Encoding.UTF8.GetBytes("id,name"));

        await Run("s3://skp-in/a b+c%20ü.zip",
                  """{"AllowedExtensions":[".zip"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""");

        Assert.Equal("a b+c%20ü.zip", SentRequest<GetObjectMetadataRequest>("GetObjectMetadataAsync").Key);
        Assert.Equal("a b+c%20ü.zip", SentRequest<GetObjectRequest>("GetObjectAsync").Key);
    }

    [Fact]
    public async Task ACancelledDispatchIsNotAFailedStep()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        HeadThrows(new OperationCanceledException(cts.Token));

        await Assert.ThrowsAsync<OperationCanceledException>(() => Run(ct: cts.Token));
    }

    [Fact]
    public async Task AnSdkTimeoutWhileTheDispatchIsLiveIsAFailedStep()
    {
        // The SDK surfaces its own Timeout as a TaskCanceledException. The dispatch token is not
        // cancelled, so this is a wedged endpoint, not a shutdown.
        HeadThrows(new TaskCanceledException("The request was canceled due to the configured timeout."));

        var message = await Failure();

        Assert.Equal($"reading {Location} failed: timed out", message);
    }
}
