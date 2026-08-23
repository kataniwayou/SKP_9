using Messaging.Transport;
using StackExchange.Redis;

namespace BaseApi.Core.Diagnostics;

/// <summary>
/// Turns a Redis failure into a <see cref="DependencyVerdict"/>.
/// <para>
/// <b>Redis discriminates worst of the three dependencies, and the reason is a decision this codebase
/// makes on purpose.</b> <c>AbortOnConnectFail</c> is forced to <c>false</c> so the multiplexer
/// materialises against a Redis that is not up yet — which is right, and which also means
/// <c>Connect</c> never throws and the client retries internally. By the time a failure surfaces at an
/// operation it has often been flattened into "No connection is available to service this operation",
/// with the original <c>WRONGPASS</c> long gone.
/// </para>
/// <para>
/// So this classifier reads two sources and prefers whichever still has the truth: the exception, and
/// the error token Redis puts at the front of its own replies. Both are checked because neither
/// survives every path — <see cref="RedisServerException"/> carries the token verbatim, while a
/// connection-level auth rejection arrives as
/// <see cref="ConnectionFailureType.AuthenticationFailure"/> with no token at all.
/// </para>
/// <para>
/// <b>What is still not recoverable from here.</b> When the multiplexer has swallowed the reason and
/// reports only that no connection is available, this returns <see cref="DependencyFault.Transient"/>
/// — the honest answer, since a dead Redis and a mis-authenticated one are genuinely
/// indistinguishable at that point. Closing that gap needs the reason captured earlier, from the
/// multiplexer's own <c>ConnectionFailed</c> event, which is a separate change.
/// </para>
/// </summary>
public static class RedisFaultClassifier
{
    private const string ConnectionKey = "ConnectionStrings:Redis";

    // Redis prefixes an error reply with a token naming the class of failure. These are the ones that
    // mean "and it will happen again"; every other token, and every absent one, resolves toward
    // waiting.
    private const string WrongPassword = "WRONGPASS";   // username/password pair rejected
    private const string NoAuth = "NOAUTH";             // a password is required and none was sent
    private const string NoPermission = "NOPERM";       // authenticated, but the ACL forbids this

    /// <inheritdoc cref="DependencyVerdict"/>
    public static DependencyVerdict Classify(Exception ex)
    {
        ArgumentNullException.ThrowIfNull(ex);

        var chain = Unwrap(ex).ToList();

        // The ACL case first: it is authenticated-but-forbidden, so it is somebody's grant rather than
        // this pod's setting, and matching it after WRONGPASS would be fine but reads worse.
        if (chain.Any(e => Mentions(e, NoPermission)))
        {
            return new DependencyVerdict(
                DependencyFault.BlockedExternal,
                "Redis authenticated this account but its ACL forbids the operation — grant it on the "
                + "server; no restart is required");
        }

        if (chain.Any(e => Mentions(e, WrongPassword) || Mentions(e, NoAuth))
            || chain.OfType<RedisConnectionException>()
                .Any(e => e.FailureType == ConnectionFailureType.AuthenticationFailure))
        {
            return new DependencyVerdict(
                DependencyFault.BlockedConfiguration,
                "Redis rejected these credentials",
                ConnectionKey);
        }

        // Everything else is a wait. RedisTimeoutException, a socket failure, a LOADING reply while
        // the server reads its dataset back, a multiplexer that has no connection yet — all clear on
        // their own, and none of them is worth a restart.
        var connection = chain.OfType<RedisConnectionException>().FirstOrDefault();

        return new DependencyVerdict(
            DependencyFault.Transient,
            connection is not null
                ? $"Redis is unreachable ({connection.FailureType})"
                : ex.Message);
    }

    /// <summary>
    /// Whether an exception's message carries a Redis error token. Ordinal and case-sensitive: the
    /// tokens are protocol constants, not prose, and a case-insensitive match would also hit an
    /// operator's own text quoting one.
    /// </summary>
    private static bool Mentions(Exception ex, string token) =>
        ex.Message.Contains(token, StringComparison.Ordinal);

    /// <summary>Flattens aggregates and walks inner exceptions, yielding every exception in the chain.</summary>
    private static IEnumerable<Exception> Unwrap(Exception ex)
    {
        if (ex is AggregateException aggregate)
        {
            foreach (var inner in aggregate.Flatten().InnerExceptions)
            {
                foreach (var e in Unwrap(inner))
                {
                    yield return e;
                }
            }

            yield break;
        }

        for (Exception? e = ex; e is not null; e = e.InnerException)
        {
            yield return e;
        }
    }
}
