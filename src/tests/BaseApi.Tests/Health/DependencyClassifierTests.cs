using BaseApi.Core.Diagnostics;
using Messaging.Transport;
using Npgsql;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Health;

/// <summary>
/// The two per-client classifiers the API needs beyond the shared broker one. Both answer the same
/// question — <i>does the operator touch this pod</i> — and both resolve ambiguity toward waiting,
/// because telling someone to wait through something that needed a restart costs a minute, while
/// telling them to restart through something that was recovering destroys the log and the backoff.
/// </summary>
public sealed class DependencyClassifierTests
{
    private static PostgresException Answered(string sqlState) =>
        new("server said no", "FATAL", "FATAL", sqlState);

    public sealed class Postgres
    {
        [Fact]
        public void ARejectedPasswordIsConfiguration_AndNamesTheConnectionString()
        {
            var verdict = PostgresFaultClassifier.Classify(
                Answered(PostgresErrorCodes.InvalidPassword));

            Assert.Equal(DependencyFault.BlockedConfiguration, verdict.Fault);
            Assert.Equal("ConnectionStrings:Postgres", verdict.SettingKey);
            Assert.True(verdict.RestartRequired);
        }

        [Fact]
        public void AServerStillBootingIsTransient_NotACredentialProblem()
        {
            // 57P03 cannot_connect_now. Npgsql marks it transient itself, and deferring to that is why
            // this classifier does not lead with SqlState matching — a classifier that did would have
            // to remember every retry-worthy code the server defines.
            var verdict = PostgresFaultClassifier.Classify(
                Answered(PostgresErrorCodes.CannotConnectNow));

            Assert.Equal(DependencyFault.Transient, verdict.Fault);
            Assert.False(verdict.RestartRequired);
        }

        [Fact]
        public void TooManyConnectionsIsTransient()
        {
            var verdict = PostgresFaultClassifier.Classify(
                Answered(PostgresErrorCodes.TooManyConnections));

            Assert.Equal(DependencyFault.Transient, verdict.Fault);
        }

        [Fact]
        public void AMissingDatabaseIsExternal_BecauseCreatingItNeedsNoRestart()
        {
            var verdict = PostgresFaultClassifier.Classify(
                Answered(PostgresErrorCodes.InvalidCatalogName));

            Assert.Equal(DependencyFault.BlockedExternal, verdict.Fault);
            Assert.False(verdict.RestartRequired);
        }

        [Fact]
        public void AMissingPrivilegeIsExternal_AndSaysNoRestartIsRequired()
        {
            var verdict = PostgresFaultClassifier.Classify(
                Answered(PostgresErrorCodes.InsufficientPrivilege));

            Assert.Equal(DependencyFault.BlockedExternal, verdict.Fault);
            Assert.Contains("no restart is required", verdict.Reason, StringComparison.Ordinal);
        }

        [Fact]
        public void NothingAnsweringIsTransient()
        {
            var verdict = PostgresFaultClassifier.Classify(
                new NpgsqlException("failed to connect", new IOException("connection refused")));

            Assert.Equal(DependencyFault.Transient, verdict.Fault);
            Assert.Contains("unreachable", verdict.Reason, StringComparison.Ordinal);
        }

        [Fact]
        public void ATransportFailureWithNoNpgsqlWrapperStillNamesPostgres()
        {
            // Observed live against a scaled-down StatefulSet: EF surfaced the socket failure with no
            // NpgsqlException anywhere in the chain, and the fallback rendered the raw errno text
            // ("Resource temporarily unavailable") — true, but naming neither Postgres nor anything to
            // act on.
            var verdict = PostgresFaultClassifier.Classify(
                new InvalidOperationException("migrate failed",
                    new System.Net.Sockets.SocketException(11)));

            Assert.Equal(DependencyFault.Transient, verdict.Fault);
            Assert.Contains("Postgres is unreachable", verdict.Reason, StringComparison.Ordinal);
        }

        [Fact]
        public void ANestedServerAnswerIsFoundBeneathAWrapper()
        {
            // EF wraps provider exceptions, so reading only the outermost type would classify every
            // migration failure as "nothing answered".
            var verdict = PostgresFaultClassifier.Classify(new InvalidOperationException(
                "migration failed", Answered(PostgresErrorCodes.InvalidPassword)));

            Assert.Equal(DependencyFault.BlockedConfiguration, verdict.Fault);
        }
    }

    public sealed class Redis
    {
        [Fact]
        public void AWrongPasswordIsConfiguration()
        {
            var verdict = RedisFaultClassifier.Classify(
                new RedisServerException("WRONGPASS invalid username-password pair"));

            Assert.Equal(DependencyFault.BlockedConfiguration, verdict.Fault);
            Assert.Equal("ConnectionStrings:Redis", verdict.SettingKey);
        }

        [Fact]
        public void AMissingPasswordIsConfiguration()
        {
            var verdict = RedisFaultClassifier.Classify(
                new RedisServerException("NOAUTH Authentication required."));

            Assert.Equal(DependencyFault.BlockedConfiguration, verdict.Fault);
        }

        [Fact]
        public void AnAclRefusalIsExternal_BecauseTheGrantIsOnTheServer()
        {
            var verdict = RedisFaultClassifier.Classify(
                new RedisServerException("NOPERM this user has no permissions to run the 'get' command"));

            Assert.Equal(DependencyFault.BlockedExternal, verdict.Fault);
            Assert.False(verdict.RestartRequired);
        }

        [Fact]
        public void AConnectionLevelAuthenticationFailureIsConfiguration()
        {
            // The token is gone by this path, so the FailureType is the only thing left carrying it.
            var verdict = RedisFaultClassifier.Classify(
                new RedisConnectionException(ConnectionFailureType.AuthenticationFailure, "auth failed"));

            Assert.Equal(DependencyFault.BlockedConfiguration, verdict.Fault);
        }

        [Fact]
        public void ASocketFailureIsTransient()
        {
            var verdict = RedisFaultClassifier.Classify(
                new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

            Assert.Equal(DependencyFault.Transient, verdict.Fault);
        }

        [Fact]
        public void ATimeoutIsTransient()
        {
            var verdict = RedisFaultClassifier.Classify(
                new RedisTimeoutException("timed out", CommandStatus.WaitingInBacklog));

            Assert.Equal(DependencyFault.Transient, verdict.Fault);
        }

        [Fact]
        public void AFlattenedNoConnectionAvailableStaysTransient()
        {
            // The honest answer, and the known limit of this classifier: with AbortOnConnectFail forced
            // false the multiplexer swallows the original reason, so a dead Redis and a
            // mis-authenticated one are genuinely indistinguishable here. Guessing "credentials" would
            // send an operator to change a password that is fine.
            var verdict = RedisFaultClassifier.Classify(new RedisConnectionException(
                ConnectionFailureType.UnableToConnect,
                "No connection is available to service this operation"));

            Assert.Equal(DependencyFault.Transient, verdict.Fault);
        }
    }
}
