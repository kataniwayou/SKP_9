using System.Net;
using System.Text;
using System.Text.Json;
using Amazon.S3;
using Amazon.S3.Model;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;

namespace Processor.ObjectPersister;

/// <summary>
/// Turns a file's bytes and its identity back into an object in a bucket, and reports where it went.
/// The S3 twin of <c>FilePersisterProcessor</c>: a plain transform with an input and an output, and
/// it sends one branch per input.
/// <para>
/// <b>The location is minted here, and that is the counterpart of the fetcher discarding it.</b> The
/// fetcher receives a location, opens it, and writes none into the envelope — deliberately, so that
/// every hop between the two ends of a workflow is location-independent. This processor is where a
/// location re-enters the branch, and it is the only place it can, because the destination is
/// configuration and the name is the file's own.
/// </para>
/// <para>
/// <b>It writes the bytes and nothing else, in one request.</b> No staging name and no rename: an S3
/// <c>PUT</c> is atomic, the object does not exist until it is complete and then exists whole, and
/// S3 has no rename to stage with. No timestamps or metadata headers either; S3 sets
/// <c>LastModified</c> itself.
/// </para>
/// </summary>
internal sealed class ObjectPersisterProcessor(
    ILogger<ObjectPersisterProcessor> logger, IAmazonS3 s3)
    : BaseProcessor<ObjectPersisterConfig>
{
    private const string S3Scheme = "s3://";
    private const string TimedOut = "timed out";

    /// <summary>S3's limit on a key, in UTF-8 bytes rather than characters.</summary>
    private const int MaxKeyBytes = 1024;

    protected override async Task ProcessAsync(
        byte[] data, ObjectPersisterConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else. A step wired to a
        // destination that is not an s3:// location is wrong before any envelope is parsed.
        var destination = Validate(config);

        var file = ReadEnvelope(data);
        var name = SafeName(file.FileName);

        var target = KeyFor(destination, name);

        await Write(target, file.Content!, ct).ConfigureAwait(false);

        // The SHAPE and the destination, never the content. The bytes are upstream data and stay out
        // of every template in this system. Same shape as FilePersister's, but the destination is
        // {ObjectPath}, not {FilePath}: an s3:// location is not a path on any volume, and the field
        // name is how a query tells the two persisters' destinations apart.
        //
        // THIS IS THE ONLY PLACE THE DESTINATION IS RECORDED, which mirrors the fetcher being the
        // only place the source is. They share the dispatch's ExecutionId and CorrelationId, so one
        // query spans both.
        logger.LogInformation(
            "persisted {FileName} ({Extension}), {SizeBytes} bytes, to {ObjectPath}",
            name, file.Extension, file.Content!.Length, target);

        var locator = JsonSerializer.SerializeToUtf8Bytes(new Locator(target.ToString()), LocatorJson.Options);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(locator, executionId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The payload, checked, and the destination it names: the bucket and the key PREFIX. Throws
    /// <see cref="FailedException"/> with the reason.
    /// </summary>
    private static ObjectUri Validate(ObjectPersisterConfig? config)
    {
        if (config is null)
        {
            // Same "step payload rejected" prefix as every other malformed-payload case: an absent
            // payload IS a malformed payload, and an operator searching for payload faults must find
            // all of them — the commonest one included — with one query.
            throw BadPayload("ObjectPersister needs DestinationUri");
        }

        if (config.DestinationUri is not { Length: > 0 } text)
        {
            throw BadPayload("DestinationUri must not be empty");
        }

        if (!ObjectUri.TryParse(text, keyIsPrefix: true, out var destination, out var why))
        {
            // By name, and not quoted back: a filesystem path is FilePersister's destination, and
            // "malformed" would send an author looking at the string rather than at the wiring.
            throw BadPayload(
                text.StartsWith(S3Scheme, StringComparison.OrdinalIgnoreCase)
                    ? $"DestinationUri is not usable: {why}"
                    : "DestinationUri must be an s3:// location; a filesystem path is FilePersister's");
        }

        return destination!;
    }

    /// <summary>
    /// The envelope, parsed and checked far enough to write. Throws <see cref="FailedException"/>
    /// with the reason.
    /// <para>
    /// The parse is wrapped rather than left to throw, for the reason
    /// <c>FilePersisterProcessor.ReadEnvelope</c> gives: a malformed upstream record is a business
    /// failure with a diagnosis, not a framework exception carrying a quoted fragment of upstream
    /// content into a log store.
    /// </para>
    /// </summary>
    private static PersistableFile ReadEnvelope(byte[] data)
    {
        PersistableFile? file;

        try
        {
            file = JsonSerializer.Deserialize<PersistableFile>(data, ProcessorConfig.SerializerOptions);
        }
        catch (JsonException)
        {
            // Swallowed on purpose: the exception's text quotes the fragment that failed to parse,
            // and that fragment is upstream content.
            throw MalformedEnvelope("the branch is not JSON");
        }

        if (file is null)
        {
            throw MalformedEnvelope("the branch is JSON null");
        }

        if (file.Content is null)
        {
            throw MalformedEnvelope("the branch carries no content");
        }

        // An EMPTY content is not a fault. A zero-byte file is a file, the fetchers admit one
        // (MinimumSizeBytes 0 disables the floor), and refusing to write it here would lose a file
        // the far end of the workflow accepted.
        return file;
    }

    /// <summary>
    /// The file name, checked to be a name and not a route. Throws <see cref="FailedException"/>
    /// with the reason.
    /// <para>
    /// <b>This check exists because the name is the one piece of UPSTREAM data that reaches the
    /// destination's address.</b> The bucket and prefix are configuration an operator wrote; the name
    /// arrives in the branch, and a branch can carry whatever a producer put in it. In S3 a
    /// <c>/</c> would not escape a directory, it would silently write under a different prefix, and
    /// the rule that prevents both is the same rule.
    /// </para>
    /// </summary>
    private static string SafeName(string? fileName)
    {
        if (fileName is not { Length: > 0 } name)
        {
            throw MalformedEnvelope("the branch carries no fileName");
        }

        // BOTH separators, explicitly, rather than Path.GetInvalidFileNameChars alone. That set is
        // platform-dependent: on Linux it is '\0' and '/', so a backslash — a separator on the
        // platform these tests run on — passes there and would make the check mean different things
        // in test and in production. Naming both makes it mean one thing everywhere.
        if (name.IndexOfAny(SeparatorChars) >= 0)
        {
            throw RejectedName(name, "it names a directory, and only a bare file name is written");
        }

        if (name is "." or "..")
        {
            throw RejectedName(name, "it names a directory, and only a bare file name is written");
        }

        if (name.IndexOf('\0') >= 0)
        {
            throw RejectedName(name, "it contains a null character");
        }

        return name;
    }

    /// <summary>Both platforms' separators, for the reason <see cref="SafeName"/> gives.</summary>
    private static readonly char[] SeparatorChars = ['/', '\\'];

    /// <summary>
    /// The object this write creates: the destination's prefix plus the name. Throws
    /// <see cref="FailedException"/> when the key is longer than S3 allows, which the prefix alone
    /// could not have been and the name alone might not be.
    /// </summary>
    private static ObjectUri KeyFor(ObjectUri destination, string name)
    {
        var key = destination.Key + name;

        if (Encoding.UTF8.GetByteCount(key) > MaxKeyBytes)
        {
            throw RejectedName(name, $"the key it makes is over S3's {MaxKeyBytes} byte limit");
        }

        return destination with { Key = key };
    }

    /// <summary>
    /// The write: one <c>PUT</c> from the bytes in memory. Every fault is a failed step regardless of
    /// cause: there is no requeue path here — the framework requeues only
    /// <c>TransientSendException</c>, which can arise solely from <c>SendToPostAsync</c> — so
    /// classifying the fault changes nothing about the disposition, only the sentence. The SDK's own
    /// message is carried (it names the code and the resource and does not echo content); its stack
    /// is not.
    /// <para>
    /// <b>A missing bucket is read off the <c>PUT</c>'s own error</b>, not asked for with a
    /// <c>HeadBucket</c> per dispatch, so the happy path costs one request. It is a payload fault,
    /// the mirror of FilePersister's absent folder: the bucket is provisioned infrastructure and is
    /// not created here.
    /// </para>
    /// <para>
    /// A cancelled dispatch is not a fault and propagates, whatever shape the SDK gave it. A
    /// cancellation while the dispatch token is still live is the SDK's own timeout, and is a failed
    /// step.
    /// </para>
    /// </summary>
    private async Task Write(ObjectUri target, byte[] content, CancellationToken ct)
    {
        try
        {
            using var body = new MemoryStream(content, writable: false);

            await s3.PutObjectAsync(
                new PutObjectRequest { BucketName = target.Bucket, Key = target.Key, InputStream = body },
                ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Before any mapping: a shutdown can reach here as a socket error as easily as an
            // OperationCanceledException, and none of them is a failed step.
            ct.ThrowIfCancellationRequested();

            if (ex is AmazonS3Exception { ErrorCode: "NoSuchBucket" })
            {
                throw BadPayload($"bucket '{target.Bucket}' does not exist; this processor does not create it");
            }

            // A policy refusal, or a 403 with no code to say otherwise. Any other 403
            // (InvalidAccessKeyId, a clock skew, ...) is not a policy refusal, and "access denied"
            // would send the operator to the wrong place; it falls to its own code below.
            if (ex is AmazonS3Exception { StatusCode: HttpStatusCode.Forbidden, ErrorCode: null or "" or "AccessDenied" })
            {
                throw Unwritable(target, "access denied");
            }

            if (ex is AmazonS3Exception { StatusCode: HttpStatusCode.Forbidden, ErrorCode: { Length: > 0 } code })
            {
                throw Unwritable(target, $"{code}: {ex.Message}");
            }

            throw Unwritable(target, ex is OperationCanceledException ? TimedOut : ex.Message);
        }
    }

    // THE FOUR FAILURE CLASSES, AND NONE OF THEM LOGS. ProcessDispatchHandler catches
    // FailedException and writes the author's message verbatim, so a line here would emit every
    // failure twice. The message text IS the contract an operator searches.

    /// <summary>A malformed payload, diagnosed before any envelope is parsed.</summary>
    private static FailedException BadPayload(string reason)
        => new($"step payload rejected: {reason}");

    /// <summary>An upstream record this processor cannot write. Never quotes the record.</summary>
    private static FailedException MalformedEnvelope(string reason)
        => new($"input branch did not carry a file: {reason}");

    /// <summary>
    /// A file name that broke a rule. Separate from MalformedEnvelope because this one has a name,
    /// and the name is the thing an operator needs to see.
    /// </summary>
    private static FailedException RejectedName(string name, string reason)
        => new($"file name '{name}' rejected: {reason}");

    /// <summary>An object that could not be written, whatever the cause.</summary>
    private static FailedException Unwritable(ObjectUri target, string reason)
        => new($"writing {target} failed: {reason}");
}
