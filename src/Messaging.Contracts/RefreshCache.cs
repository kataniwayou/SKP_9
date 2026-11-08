namespace Messaging.Contracts;

/// <summary>
/// Control message: align this cache's dictionary in L2 with its row, in every running workflow that
/// projected it. Sent by <c>PUT /caches/{id}/items</c> once the row is saved.
/// <para>
/// <b>An id, not the items.</b> The consumer reads the row when it handles the message, so two edits
/// applied out of order, or one redelivered, still leave L2 holding what the database holds now.
/// </para>
/// </summary>
/// <param name="CacheId">The cache whose items changed.</param>
public sealed record RefreshCache(Guid CacheId);
