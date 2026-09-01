using System.Collections;
using Xunit;

using ApiSnapshot     = BaseApi.Core.Startup.EnvironmentSnapshot;
using ConsoleSnapshot = BaseConsole.Core.Startup.EnvironmentSnapshot;

namespace BaseApi.Tests.Startup;

/// <summary>
/// The startup block that tells an operator what this process was actually configured with, and the
/// redaction that keeps a live password out of Elasticsearch.
/// <para>
/// Both cores carry their own copy — they share no project a startup diagnostic belongs in — so every
/// case here is asserted against the API's copy and the console's, and one test feeds the same
/// environment to both and compares the rendered output. That pairing is the only thing keeping the
/// two from drifting, exactly as it is for <c>HealthProbeLog</c>.
/// </para>
/// </summary>
public sealed class EnvironmentSnapshotTests
{
    private static Hashtable Env(params (string Key, string Value)[] entries)
    {
        var table = new Hashtable();
        foreach (var (key, value) in entries)
        {
            table[key] = value;
        }

        return table;
    }

    private static string Render(IDictionary env) => string.Join("\n", ApiSnapshot.Lines(env));

    [Theory]
    [InlineData("POSTGRES_PASSWORD")]
    [InlineData("RabbitMq__Password")]
    [InlineData("Some__Secret")]
    [InlineData("Foo__ApiKey")]
    [InlineData("Auth__Token")]
    [InlineData("Db__Credential")]
    [InlineData("legacy__PWD")]
    public void MasksAnyKeyThatNamesACredential(string key)
    {
        var rendered = Render(Env((key, "hunter2")));

        Assert.Contains(key, rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("hunter2", rendered, StringComparison.Ordinal);
        Assert.Contains("***", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void MasksThePasswordKubernetesExpandedInsideAConnectionString()
    {
        // The second copy of the same secret. Kubernetes substitutes $(POSTGRES_PASSWORD) at pod
        // creation, so masking only the standalone key still ships the password in this value.
        var rendered = Render(Env(
            ("ConnectionStrings__Postgres",
             "Host=postgres;Port=5432;Database=stepsdb;Username=skp;Password=hunter2")));

        Assert.DoesNotContain("hunter2", rendered, StringComparison.Ordinal);
        Assert.Contains("Host=postgres", rendered, StringComparison.Ordinal);
        Assert.Contains("Database=stepsdb", rendered, StringComparison.Ordinal);
        Assert.Contains("Username=skp", rendered, StringComparison.Ordinal);
        Assert.Contains("Password=***", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void MasksACommaDelimitedRedisPasswordToo()
    {
        var rendered = Render(Env(("ConnectionStrings__Redis", "redis:6379,password=hunter2,ssl=True")));

        Assert.DoesNotContain("hunter2", rendered, StringComparison.Ordinal);
        Assert.Contains("redis:6379", rendered, StringComparison.Ordinal);
        Assert.Contains("ssl=True", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ShowsEverythingThatIsNotACredential()
    {
        // The whole point of the block: an operator has to be able to see that these are what they
        // meant. A database name or a username masked "to be safe" answers nothing.
        var rendered = Render(Env(
            ("Service__Name", "baseapi"),
            ("POSTGRES_DB", "stepsdb"),
            ("RabbitMq__Username", "guest"),
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4317"),
            ("ASPNETCORE_ENVIRONMENT", "Production")));

        Assert.Contains("baseapi", rendered, StringComparison.Ordinal);
        Assert.Contains("stepsdb", rendered, StringComparison.Ordinal);
        Assert.Contains("guest", rendered, StringComparison.Ordinal);
        Assert.Contains("http://otel-collector:4317", rendered, StringComparison.Ordinal);
        Assert.Contains("Production", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("***", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void KeepsTheApplicationSurfaceAndDropsTheContainerNoise()
    {
        var lines = ApiSnapshot.Lines(Env(
            ("Service__Name", "baseapi"),
            ("OTEL_METRIC_EXPORT_INTERVAL", "10000"),
            ("POD_NAME", "baseapi-0"),
            ("ASPNETCORE_ENVIRONMENT", "Production"),
            ("POSTGRES_DB", "stepsdb"),
            ("PATH", "/usr/bin"),
            ("HOSTNAME", "baseapi-0"),
            ("DOTNET_RUNNING_IN_CONTAINER", "true"),
            ("KUBERNETES_SERVICE_HOST", "10.96.0.1"),
            ("REDIS_PORT_6379_TCP_ADDR", "10.96.0.7"),
            ("RABBITMQ_SERVICE_PORT", "5672"),
            ("POSTGRES_PORT", "tcp://10.96.0.3:5432")));

        Assert.Equal(5, lines.Count);
        foreach (var noise in new[] { "PATH", "HOSTNAME", "DOTNET_", "KUBERNETES_", "_TCP_ADDR", "_SERVICE_PORT" })
        {
            Assert.DoesNotContain(lines, l => l.Contains(noise, StringComparison.Ordinal));
        }
    }

    [Fact]
    public void KeepsASingleUnderscoreSettingTheOperatorActuallySet()
    {
        // POSTGRES_DB and its siblings carry no "__" separator but are read by this system and set in
        // the manifest. An allowlist built on the separator dropped all three silently, which is what
        // moved the rule to a denylist.
        var lines = ApiSnapshot.Lines(Env(
            ("POSTGRES_DB", "stepsdb"), ("POSTGRES_USER", "skp"), ("POSTGRES_PASSWORD", "hunter2")));

        Assert.Equal(3, lines.Count);
        Assert.Contains(lines, l => l.Contains("stepsdb", StringComparison.Ordinal));
        Assert.Contains(lines, l => l.Contains("skp", StringComparison.Ordinal));
        Assert.DoesNotContain(lines, l => l.Contains("hunter2", StringComparison.Ordinal));
    }

    [Fact]
    public void SurfacesAMisspelledKeyRatherThanHidingIt()
    {
        // The block is most valuable when the operator set something the application never read.
        var lines = ApiSnapshot.Lines(Env(("Servce__Name", "baseapi")));

        Assert.Single(lines);
        Assert.Contains("Servce__Name", lines[0], StringComparison.Ordinal);
    }

    [Fact]
    public void SortsByNameSoTwoPodsRenderComparably()
    {
        var lines = ApiSnapshot.Lines(Env(
            ("Zebra__Setting", "z"), ("Alpha__Setting", "a"), ("Middle__Setting", "m")));

        Assert.Collection(
            lines,
            l => Assert.Contains("Alpha__Setting", l, StringComparison.Ordinal),
            l => Assert.Contains("Middle__Setting", l, StringComparison.Ordinal),
            l => Assert.Contains("Zebra__Setting", l, StringComparison.Ordinal));
    }

    [Fact]
    public void RendersNothingForAnEnvironmentThatIsAllNoise()
        => Assert.Empty(ApiSnapshot.Lines(Env(
            ("PATH", "/usr/bin"), ("HOSTNAME", "h"), ("KUBERNETES_SERVICE_HOST", "10.96.0.1"))));

    [Fact]
    public void TheTwoCopiesRenderIdentically()
    {
        // The only guard against the duplication drifting. Every branch of the renderer is exercised
        // here: masked key, inline secret, plain value, dropped noise, sorting and column alignment.
        var env = Env(
            ("Service__Name", "orchestrator"),
            ("Service__Version", "0.0.0"),
            ("RabbitMq__Host", "rabbitmq"),
            ("RabbitMq__Password", "hunter2"),
            ("ConnectionStrings__Postgres", "Host=postgres;Password=hunter2"),
            ("ConnectionStrings__Redis", "redis:6379,abortConnect=false"),
            ("POD_NAME", "orchestrator-0"),
            ("ASPNETCORE_ENVIRONMENT", "Production"),
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4317"),
            ("PATH", "/usr/bin"));

        Assert.Equal(ApiSnapshot.Lines(env), ConsoleSnapshot.Lines(env));
    }
}
