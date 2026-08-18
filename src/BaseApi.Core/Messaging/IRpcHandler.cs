namespace BaseApi.Core.Messaging;

/// <summary>
/// One reply produced by an <see cref="IRpcHandler"/>: the discriminator the caller will read from
/// the reply's type header, and the serialized body.
/// <para>
/// The type travels separately from the body because a query can legitimately answer with more than
/// one shape — found and not-found are both successful answers, not an answer and an error — and a
/// caller needs to tell them apart before attempting to read either.
/// </para>
/// </summary>
public sealed record RpcReply(string Type, ReadOnlyMemory<byte> Body);

/// <summary>
/// Answers one kind of request arriving on a query queue.
/// <para>
/// <b>These are reads, and are deliberately not gated on the projection store.</b> A query that
/// answers from the database has no reason to stop being answerable because the projection store is
/// unavailable, and pausing it would turn one dependency's outage into a second, unrelated one.
/// </para>
/// <para>
/// <b>A handler answers; it does not fail.</b> An absent record is a reply with a not-found shape, not
/// an exception — the caller needs an answer it can act on rather than a timeout. Exceptions are
/// reserved for a request that cannot be understood at all, which leaves the caller waiting and is
/// what the request timeout on their side exists for.
/// </para>
/// </summary>
public interface IRpcHandler
{
    /// <summary>The request type discriminator this handler claims.</summary>
    string RequestType { get; }

    /// <summary>Produce the reply for one request body.</summary>
    Task<RpcReply> HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct);
}
