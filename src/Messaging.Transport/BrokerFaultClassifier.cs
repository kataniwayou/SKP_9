using System.Net.Sockets;
using RabbitMQ.Client.Exceptions;

namespace Messaging.Transport;

/// <summary>
/// Why a broker connection could not be opened, in the one form an operator reading
/// <c>kubectl logs</c> can act on: whether nothing answered, or something answered and refused us.
/// <para>
/// <b>The distinction this exists to restore.</b> Every dependency loop in this system treats an
/// unreachable broker and a rejected credential identically — same catch, same backoff, same forever
/// — because both are conditions a broker that is still starting can legitimately produce, and
/// giving up on either would be wrong. That is correct control flow and terrible diagnostics: the
/// operator is left with a message that says the connection failed and an attached exception they
/// have to widen the console to read. Classifying does not change what any loop does; it changes
/// what the loop can say while it does it.
/// </para>
/// <para>
/// <b>The whole exception chain is walked, not just the outermost type</b> — the same reason
/// <c>L2FaultClassifier</c> walks it. The client wraps an authentication failure inside a
/// <see cref="BrokerUnreachableException"/>, so reading only the outer type reports every rejected
/// password as an unreachable host, which is the single most misleading answer available here.
/// Refusals are therefore tested before unreachability, not after.
/// </para>
/// </summary>
public static class BrokerFaultClassifier
{
    /// <summary>What kind of failure a broker exception describes.</summary>
    public enum Fault
    {
        /// <summary>Nothing answered: no route, no listener, or a connect that timed out.</summary>
        Unreachable,

        /// <summary>The broker answered and rejected the username or password.</summary>
        Credentials,

        /// <summary>The credentials were accepted; the virtual host or its permissions were not.</summary>
        Authorisation,

        /// <summary>Something else. The exception's own message is the best available answer.</summary>
        Other,
    }

    /// <inheritdoc cref="Fault"/>
    public static Fault Classify(Exception ex)
    {
        ArgumentNullException.ThrowIfNull(ex);

        var chain = Unwrap(ex).ToList();

        // Refusals first: the client nests these inside BrokerUnreachableException, so testing
        // unreachability first would swallow every one of them.
        if (chain.Any(e => e is AuthenticationFailureException or PossibleAuthenticationFailureException))
        {
            return Fault.Credentials;
        }

        // 403 ACCESS_REFUSED and 530 NOT_ALLOWED are both "we know who you are and you may not have
        // this vhost". They arrive as a connection shutdown rather than as a typed exception, so the
        // reply code is the only thing that identifies them.
        if (chain.OfType<OperationInterruptedException>().Any(e =>
                e.ShutdownReason?.ReplyCode is AccessRefused or NotAllowed))
        {
            return Fault.Authorisation;
        }

        if (chain.Any(e => e is SocketException or ConnectFailureException or BrokerUnreachableException))
        {
            return Fault.Unreachable;
        }

        return Fault.Other;
    }

    /// <summary>
    /// A short phrase naming the failure and, where one exists, the configuration key that fixes it.
    /// Written to be readable inline in a log line without widening the console — the full exception
    /// is attached separately at every call site and stays the authority on detail.
    /// </summary>
    public static string Describe(Exception ex) => Classify(ex) switch
    {
        Fault.Credentials =>
            "the broker rejected these credentials — check RabbitMq:Username and RabbitMq:Password",
        Fault.Authorisation =>
            "the broker refused this account access to the virtual host — check RabbitMq:VirtualHost "
            + "and the account's permissions",
        Fault.Unreachable =>
            "the broker is unreachable — check RabbitMq:Host and RabbitMq:Port, and that the broker is up",
        _ => ex.Message,
    };

    // Named rather than inlined so the two reply codes are readable at the call site; the client
    // exposes them on Constants, but importing that type for two integers pulls its whole surface
    // into a file that otherwise needs none of it.
    private const ushort AccessRefused = 403;
    private const ushort NotAllowed = 530;

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
