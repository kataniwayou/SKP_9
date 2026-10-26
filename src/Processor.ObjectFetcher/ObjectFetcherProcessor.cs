using System.Net;
using System.Text.Json;
using Amazon.S3;
using Amazon.S3.Model;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Processor.ObjectFetcher;

/// <summary>
/// Turns an <c>s3://</c> location into the object's bytes and its identity: the S3 twin of
/// FileFetcher. A plain downstream transform: it has an input and it produces output, and it sends
/// one branch per input.
/// <para>
/// <b>It never downloads an object it has not already admitted.</b> Every check below reads the
/// response to a <c>HEAD</c>, which carries metadata only, so an object that fails one is never
/// transferred at all. The <c>GET</c> that follows is conditional on the <c>HEAD</c>'s ETag, so the
/// bytes returned are the bytes that were inspected.
/// </para>
/// </summary>
internal sealed class ObjectFetcherProcessor(
    ILogger<ObjectFetcherProcessor> logger,
    IOptions<ObjectFetcherOptions> options,
    IAmazonS3 s3)
    : BaseProcessor<ObjectFetcherConfig>
{
    private const string S3Scheme = "s3://";
    private const string TimedOut = "timed out";

    private readonly long _podCeiling = options.Value.MaxObjectSizeBytes;

    protected override async Task ProcessAsync(
        byte[] data, ObjectFetcherConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else. A step wired with a
        // ceiling this pod cannot honour is wrong before any object is named.
        var (settings, whitelist) = Validate(config);

        var uri = ReadUri(data);
        var head = await Inspect(uri, settings, whitelist, ct).ConfigureAwait(false);

        var bytes = await Read(uri, head, ct).ConfigureAwait(false);

        var envelope = new FetchedFile(
            FileNameOf(uri),
            Path.GetExtension(FileNameOf(uri)),
            head.Length,
            // S3 records no creation time, and the registered envelope schema admits null.
            null,
            head.ModifiedUtc,
            bytes);

        // The SHAPE, never the content, and never the location: the uri is upstream content and
        // appears only in the failure messages. Same template as FileFetcher, so one query finds
        // both pairs' fetches.
        logger.LogInformation(
            "fetched {FileName} ({Extension}), {SizeBytes} bytes, modified {ModifiedUtc}",
            envelope.FileName, envelope.Extension, envelope.SizeBytes, envelope.ModifiedUtc);

        var document = JsonSerializer.SerializeToUtf8Bytes(envelope, FetchedFileJson.Options);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(document, executionId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The payload, checked, and the whitelist it resolves to. Throws <see cref="FailedException"/>
    /// with the reason.
    /// </summary>
    private (ObjectFetcherConfig Settings, IReadOnlyList<string> Whitelist) Validate(
        ObjectFetcherConfig? config)
    {
        if (config is null)
        {
            // Same "step payload rejected" prefix as every other malformed-payload case below: an
            // absent payload IS a malformed payload, and an operator searching for payload faults
            // must find all of them with one query.
            throw BadPayload(
                "ObjectFetcher needs AllowedExtensions, MinimumSizeBytes and MaximumSizeBytes");
        }

        var whitelist = ExtensionWhitelist.Resolve(config.AllowedExtensions);

        if (ExtensionWhitelist.FirstMalformed(whitelist) is { } malformed)
        {
            // Quoted back, not normalised. An author who wrote "zip" has to see "zip".
            throw BadPayload(
                $"an allowed extension must start with a dot or be "
                + $"'{ExtensionWhitelist.Wildcard}'; the payload named '{malformed}'");
        }

        if (config.MinimumSizeBytes < 0)
        {
            throw BadPayload("MinimumSizeBytes must not be negative");
        }

        if (config.MaximumSizeBytes < 1)
        {
            throw BadPayload("MaximumSizeBytes must be at least 1");
        }

        if (config.MinimumSizeBytes > config.MaximumSizeBytes)
        {
            throw BadPayload(
                $"MinimumSizeBytes {config.MinimumSizeBytes} is above MaximumSizeBytes "
                + $"{config.MaximumSizeBytes}");
        }

        if (config.MaximumSizeBytes > _podCeiling)
        {
            // NOT clamped. Silently lowering it would have the author's 100MB expectation fail at 32
            // with nothing saying which number won.
            throw BadPayload(
                $"MaximumSizeBytes {config.MaximumSizeBytes} is above this pod's ceiling of "
                + $"{_podCeiling}; raise ObjectFetcher__MaxObjectSizeBytes or lower the step");
        }

        return (config, whitelist);
    }

    /// <summary>The facts the dry inspection yields, and the read needs.</summary>
    private readonly record struct Head(long Length, DateTime? ModifiedUtc, string? ETag);

    /// <summary>
    /// The dry inspection: existence, extension, size. A <c>HEAD</c> transfers no body, so an object
    /// that fails here is never downloaded.
    /// </summary>
    private async Task<Head> Inspect(
        ObjectUri uri, ObjectFetcherConfig config, IReadOnlyList<string> whitelist,
        CancellationToken ct)
    {
        var response = await Call(
            uri,
            () => s3.GetObjectMetadataAsync(
                new GetObjectMetadataRequest { BucketName = uri.Bucket, Key = uri.Key }, ct),
            ct).ConfigureAwait(false);

        // SDK 4 reports ContentLength as a plain long (0 when the header is absent), so there is no
        // "no length" case to fail on: a HEAD that omits it reads as an empty object, and the body
        // then runs past the reported 0 bytes and fails the read.
        var length = response.ContentLength;

        var extension = Path.GetExtension(FileNameOf(uri));

        if (!ExtensionWhitelist.Admits(whitelist, extension))
        {
            // The list is named so an operator does not have to go and read the step payload.
            throw Rejected(uri,
                $"extension '{extension}' is not in the allowed list "
                + $"({ExtensionWhitelist.Describe(whitelist)})");
        }

        if (length < config.MinimumSizeBytes)
        {
            throw Rejected(uri, $"{length} bytes is below the {config.MinimumSizeBytes} byte floor");
        }

        if (length > config.MaximumSizeBytes)
        {
            throw Rejected(uri, $"{length} bytes is above the {config.MaximumSizeBytes} byte ceiling");
        }

        return new Head(length, ToUtc(response.LastModified), response.ETag);
    }

    /// <summary>
    /// The read, conditional on the inspected ETag: an object replaced in between answers 412 and
    /// fails the step instead of returning bytes the checks never saw. The buffer is exactly the
    /// reported length, so a body that is longer than that fails rather than grows it.
    /// </summary>
    private async Task<byte[]> Read(ObjectUri uri, Head head, CancellationToken ct)
    {
        if (head.Length > Array.MaxLength)
        {
            throw Unreadable(uri, "it is larger than this processor can hold in memory");
        }

        var buffer = new byte[head.Length];
        var filled = 0;
        var overrun = false;

        using var response = await Call(
            uri,
            () => s3.GetObjectAsync(
                new GetObjectRequest { BucketName = uri.Bucket, Key = uri.Key, EtagToMatch = head.ETag },
                ct),
            ct).ConfigureAwait(false);

        await Call(
            uri,
            async () =>
            {
                var body = response.ResponseStream;

                while (filled < buffer.Length)
                {
                    var read = await body.ReadAsync(buffer.AsMemory(filled), ct).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }

                    filled += read;
                }

                // One more byte, only when the buffer is full: any answer but zero means the body is
                // longer than the HEAD said.
                if (filled == buffer.Length)
                {
                    overrun = await body.ReadAsync(new byte[1], ct).ConfigureAwait(false) > 0;
                }

                return 0;
            },
            ct).ConfigureAwait(false);

        if (overrun)
        {
            throw Unreadable(uri, $"the body ran past the reported {head.Length} bytes");
        }

        if (filled < buffer.Length)
        {
            throw Unreadable(uri, $"the body ended after {filled} of {head.Length} bytes");
        }

        return buffer;
    }

    /// <summary>
    /// One SDK call, with every fault a failed step regardless of cause: there is no requeue path
    /// here — the framework requeues only <c>TransientSendException</c>, which can arise solely from
    /// <c>SendToPostAsync</c> — so classifying the fault changes nothing about the disposition, only
    /// the sentence. The SDK's own message is carried (it names the code and the resource and does
    /// not echo content); its stack is not.
    /// <para>
    /// A cancelled dispatch is not a fault and propagates. A cancellation while the dispatch token is
    /// still live is the SDK's own timeout, and is a failed step.
    /// </para>
    /// </summary>
    private static async Task<T> Call<T>(ObjectUri uri, Func<Task<T>> call, CancellationToken ct)
    {
        try
        {
            return await call().ConfigureAwait(false);
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            // A HEAD has no body, so a missing bucket and a missing key are indistinguishable.
            throw Unreadable(uri, "it does not exist (bucket or key)");
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == HttpStatusCode.Forbidden)
        {
            throw Unreadable(uri, "access denied");
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
        {
            throw Unreadable(uri, "it changed between inspection and read");
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            throw Unreadable(uri, ex is OperationCanceledException ? TimedOut : ex.Message);
        }
    }

    private static string FileNameOf(ObjectUri uri) => uri.Key[(uri.Key.LastIndexOf('/') + 1)..];

    private static DateTime? ToUtc(DateTime? stamp)
        => stamp is { } value
            ? value.Kind == DateTimeKind.Utc ? value : value.ToUniversalTime()
            : null;

    // THE FAILURE CLASSES, AND NONE OF THEM LOGS. ProcessDispatchHandler catches FailedException and
    // writes the author's message verbatim, so a line here would emit every failure twice. The
    // message text IS the contract an operator searches.

    /// <summary>A malformed payload, diagnosed before any location has been read.</summary>
    private static FailedException BadPayload(string reason)
        => new($"step payload rejected: {reason}");

    /// <summary>An object that broke a rule. Separate from BadPayload because this one has a location.</summary>
    private static FailedException Rejected(ObjectUri uri, string reason)
        => new($"object {uri} rejected: {reason}");

    /// <summary>An object that could not be read, whatever the cause.</summary>
    private static FailedException Unreadable(ObjectUri uri, string reason)
        => new($"reading {uri} failed: {reason}");

    /// <summary>
    /// The object this dispatch names, or a failed step saying why there isn't one.
    /// <para>
    /// The parse is wrapped rather than left to throw: a malformed upstream record is a business
    /// failure with a diagnosis, not a framework exception with a sanitized message.
    /// </para>
    /// </summary>
    private static ObjectUri ReadUri(byte[] data)
    {
        Locator? locator;
        var reason = "the branch is not JSON";

        try
        {
            locator = JsonSerializer.Deserialize<Locator>(data, ProcessorConfig.SerializerOptions);
        }
        catch (JsonException)
        {
            // Swallowed on purpose. The exception's text quotes the fragment that failed to parse,
            // and that fragment is upstream content — it must not reach a log store. The class of
            // fault is what is reported; the ids in the open scope are how it is traced back.
            locator = null;
        }

        if (locator?.Location is { Length: > 0 } location)
        {
            // By name, and not by quoting: anything that is not s3:// is a location this processor
            // cannot open, and "malformed" would send an operator looking at the string rather than
            // at the wiring. The location itself is upstream content and stays out of the message.
            if (!location.StartsWith(S3Scheme, StringComparison.OrdinalIgnoreCase))
            {
                throw new FailedException(
                    "input branch did not name a location this processor reads: a filesystem path is "
                    + "FileFetcher's; this processor reads an s3:// location");
            }

            if (ObjectUri.TryParse(location, keyIsPrefix: false, out var uri, out var why))
            {
                return uri!;
            }

            reason = why!;
        }
        else if (locator is not null)
        {
            reason = "the branch carries no location";
        }

        throw new FailedException($"input branch did not name a location: {reason}");
    }
}
