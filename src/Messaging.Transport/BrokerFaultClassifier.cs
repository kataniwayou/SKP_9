using System.Net.Sockets;
using RabbitMQ.Client.Exceptions;

namespace Messaging.Transport;

/// <summary>
/// Turns a broker failure into a <see cref="DependencyVerdict"/>: whether nothing answered, or
/// something answered and refused us, and what an operator should do about it.
/// <para>
/// <b>The distinction this exists to restore.</b> Every dependency loop in this system treats an
/// unreachable broker and a rejected credential identically — same catch, same backoff, same forever
/// — because both are conditions a broker that is still starting can legitimately produce, and
/// giving up on either would be wrong. That is correct control flow and terrible diagnostics.
/// Classifying does not change what any loop does; it changes what the loop can say while it does it.
/// </para>
/// <para>
/// <b>The whole exception chain is walked, not just the outermost type</b> — the same reason
/// <c>L2FaultClassifier</c> walks it. The client wraps an authentication failure inside a
/// <see cref="BrokerUnreachableException"/>, so reading only the outer type reports every rejected
/// password as an unreachable host, which is the single most misleading answer available here.
/// Refusals are therefore tested before unreachability, not after.
/// </para>
/// <para>
/// <b>Ambiguity resolves toward waiting, never toward a restart.</b> An unrecognised failure is
/// <see cref="DependencyFault.Transient"/>, because the cost of telling an operator to wait through
/// something that needed a restart is one extra minute, while the cost of telling them to restart
/// through something that was recovering is a destroyed log and a lost backoff.
/// </para>
/// </summary>
public static class BrokerFaultClassifier
{
    /// <summary>The configuration keys this classifier can name.</summary>
    private const string CredentialKeys = "RabbitMq:Username / RabbitMq:Password";

    // AMQP reply codes. Named rather than inlined so the call site reads; the client exposes them on
    // Constants, but importing that type for three integers pulls its whole surface into a file that
    // needs none of it.
    private const ushort AccessRefused = 403;       // authenticated, but not allowed this vhost
    private const ushort PreconditionFailed = 406;  // the queue exists with different arguments
    private const ushort NotAllowed = 530;          // the vhost is not available to this account

    /// <inheritdoc cref="DependencyVerdict"/>
    public static DependencyVerdict Classify(Exception ex)
    {
        ArgumentNullException.ThrowIfNull(ex);

        var chain = Unwrap(ex).ToList();

        // Refusals first: the client nests these inside BrokerUnreachableException, so testing
        // unreachability first would swallow every one of them.
        if (chain.Any(e => e is AuthenticationFailureException))
        {
            return new DependencyVerdict(
                DependencyFault.BlockedConfiguration,
                "the broker rejected these credentials",
                CredentialKeys);
        }

        var shutdown = chain.OfType<OperationInterruptedException>()
            .Select(e => e.ShutdownReason?.ReplyCode)
            .FirstOrDefault(code => code is AccessRefused or PreconditionFailed or NotAllowed);

        if (shutdown is AccessRefused or NotAllowed)
        {
            // External rather than configuration, deliberately — see DependencyFault.BlockedExternal.
            // A grant lands without a restart; a mistyped vhost is fixed in the manifest, which
            // redeploys anyway. Both possibilities are named because the broker does not say which.
            return new DependencyVerdict(
                DependencyFault.BlockedExternal,
                "the broker refused this account access to the virtual host — either the account "
                + "lacks permission on it, or RabbitMq:VirtualHost names the wrong one");
        }

        if (shutdown is PreconditionFailed)
        {
            // The classic redeploy failure: a queue already exists with different arguments, so the
            // declaration fails every time. No amount of waiting helps and no restart helps either —
            // the queue has to be reconciled.
            return new DependencyVerdict(
                DependencyFault.BlockedExternal,
                "a queue already exists with different arguments than this topology declares, so the "
                + "declaration is refused every attempt");
        }

        if (chain.Any(e => e is PossibleAuthenticationFailureException))
        {
            // Deliberately transient despite the name. The client raises this when the connection dies
            // during the handshake WITHOUT the broker saying why, which a broker that is still booting
            // also produces. Calling it a credential fault would tell an operator to go change a
            // password that is fine, during a twenty-second startup.
            return new DependencyVerdict(
                DependencyFault.Transient,
                "the broker ended the handshake without saying why — usually a broker still starting; "
                + $"if it persists once the broker is up, suspect {CredentialKeys}");
        }

        if (chain.Any(e => e is SocketException or ConnectFailureException or BrokerUnreachableException))
        {
            return new DependencyVerdict(
                DependencyFault.Transient,
                "the broker is unreachable — nothing answered at RabbitMq:Host / RabbitMq:Port");
        }

        return new DependencyVerdict(DependencyFault.Transient, ex.Message);
    }

    /// <summary>
    /// The verdict's reason alone, for call sites that render one inline and attach the exception
    /// separately.
    /// </summary>
    public static string Describe(Exception ex) => Classify(ex).Reason;

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
