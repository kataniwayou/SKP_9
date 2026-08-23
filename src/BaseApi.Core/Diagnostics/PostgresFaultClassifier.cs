using System.Net.Sockets;
using Messaging.Transport;
using Npgsql;

namespace BaseApi.Core.Diagnostics;

/// <summary>
/// Turns a Postgres failure into a <see cref="DependencyVerdict"/>.
/// <para>
/// <b>Postgres discriminates better than the other two dependencies, and almost for free.</b> A
/// <see cref="PostgresException"/> means the server answered and refused us; anything else means
/// nothing answered. On top of that, Npgsql already ships <see cref="NpgsqlException.IsTransient"/>,
/// which covers the codes the server itself defines as retry-worthy — <c>57P03 cannot_connect_now</c>
/// while it boots, <c>53300 too_many_connections</c>, the <c>08*</c> connection class. Verified
/// directly against Npgsql 8.0.9: it answers false for <c>28P01</c>, <c>3D000</c> and <c>42501</c>,
/// and true for <c>57P03</c>, <c>53300</c> and <c>08006</c>.
/// </para>
/// <para>
/// So this type does not re-derive what the driver already knows. It defers to
/// <c>IsTransient</c> and only adds what the driver has no opinion about: <i>which</i> non-transient
/// failures are the operator's configuration and which are somebody else's grant.
/// </para>
/// </summary>
public static class PostgresFaultClassifier
{
    private const string ConnectionKey = "ConnectionStrings:Postgres";

    /// <inheritdoc cref="DependencyVerdict"/>
    public static DependencyVerdict Classify(Exception ex)
    {
        ArgumentNullException.ThrowIfNull(ex);

        var postgres = Unwrap(ex).OfType<PostgresException>().FirstOrDefault();

        if (postgres is not null)
        {
            return ClassifyServerAnswer(postgres);
        }

        // Nothing answered. The socket types are matched alongside NpgsqlException rather than relying
        // on it alone: against a host that is simply gone, EF surfaces the transport failure without
        // an Npgsql wrapper anywhere in the chain, and the fallback then rendered the raw errno text
        // ("Resource temporarily unavailable") — a true statement that names neither Postgres nor
        // anything an operator can act on. Observed against a scaled-down StatefulSet.
        var unreachable = Unwrap(ex).Any(e =>
            e is NpgsqlException or SocketException or IOException or TimeoutException);

        return new DependencyVerdict(
            DependencyFault.Transient,
            unreachable
                ? "Postgres is unreachable — nothing answered at the host in ConnectionStrings:Postgres"
                : ex.Message);
    }

    private static DependencyVerdict ClassifyServerAnswer(PostgresException ex)
    {
        // The server's own verdict comes first. A booting server answering "cannot connect now" is
        // the case most likely to be misread as a credential problem by a classifier that led with
        // SqlState matching instead.
        if (ex.IsTransient)
        {
            return new DependencyVerdict(
                DependencyFault.Transient,
                $"Postgres answered but is not ready yet ({ex.SqlState}: {ex.MessageText})");
        }

        return ex.SqlState switch
        {
            PostgresErrorCodes.InvalidPassword or PostgresErrorCodes.InvalidAuthorizationSpecification =>
                new DependencyVerdict(
                    DependencyFault.BlockedConfiguration,
                    $"Postgres rejected these credentials ({ex.SqlState})",
                    ConnectionKey),

            // External rather than configuration: creating the database fixes it with no restart, and
            // a mistyped database name is fixed in the manifest, which redeploys anyway. Same
            // reasoning as the broker's refused virtual host.
            PostgresErrorCodes.InvalidCatalogName =>
                new DependencyVerdict(
                    DependencyFault.BlockedExternal,
                    "the database named in ConnectionStrings:Postgres does not exist — either create "
                    + "it, or the connection string names the wrong one"),

            PostgresErrorCodes.InsufficientPrivilege =>
                new DependencyVerdict(
                    DependencyFault.BlockedExternal,
                    "this account is authenticated but lacks the privileges it needs — grant them on "
                    + "the server; no restart is required"),

            // The server answered and refused, and the driver says it will refuse again. That is not
            // a wait, but naming a setting would be a guess.
            _ => new DependencyVerdict(
                DependencyFault.BlockedExternal,
                $"Postgres refused this operation and will refuse it again ({ex.SqlState}: {ex.MessageText})"),
        };
    }

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
