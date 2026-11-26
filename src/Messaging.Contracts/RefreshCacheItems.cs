namespace Messaging.Contracts;

/// <summary>
/// Control message: align these keys of this cache in L2 with the rows, in every running workflow that
/// projected it. Sent by <c>POST /caches/{id}/items</c> and <c>POST /caches/{id}/items/remove</c> once the
/// rows are saved, in chunks of at most one refresh chunk of keys, so a message stays small however large
/// the batch.
/// <para>
/// <b>Keys, not values.</b> The consumer reads each key's current row when it handles the message: a key
/// with a row is written to L2, a key without one is removed from it. Redelivery or reordering leaves L2
/// holding what the database holds now.
/// </para>
/// </summary>
/// <param name="CacheId">The cache whose items changed.</param>
/// <param name="Keys">The keys to align; each is a key as stored, without the root.</param>
public sealed record RefreshCacheItems(Guid CacheId, List<string> Keys);
