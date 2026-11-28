using System.Collections;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Validation;
using Json.Schema;
using Xunit;

namespace BaseApi.Tests.Processor;

/// <summary>
/// The validator runs on every dispatch's input and every branch's output, so whatever it keeps per
/// call is kept per message. On 2026-11-28 it kept a schema registration per call in
/// <c>SchemaRegistry.Global</c>: 17,385 of them in one archive-collapser heap, and the kafka-importer
/// ran out of memory and failed its steps.
/// <para>
/// <b>In the serialised collection on purpose.</b> These tests count <c>SchemaRegistry.Global</c>,
/// which is process-wide, and other classes (the API-side schema validators) parse schemas into it.
/// Run alongside them, the counts would include their parses.
/// </para>
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class ProcessorJsonSchemaValidatorMemoryTests
{
    private const string Locator = """
        {"type":"object","required":["location"],"properties":{"location":{"type":"string","minLength":1}},"additionalProperties":false}
        """;

    private const string NumberSchema = """
        {"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}
        """;

    private static byte[] Utf8(string s) => Encoding.UTF8.GetBytes(s);

    /// <summary>
    /// How many schemas the library's global registry holds. It is private library state, so this
    /// reads it by reflection; a library upgrade that renames the field fails here by name rather
    /// than letting the leak test pass on a zero it never measured.
    /// </summary>
    private static int GlobalRegistrations()
    {
        var field = typeof(SchemaRegistry).GetField("_registered", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.True(field is not null,
            "SchemaRegistry._registered is gone (a JsonSchema.Net upgrade?): find what now holds the global registrations");
        return Assert.IsAssignableFrom<ICollection>(field!.GetValue(SchemaRegistry.Global)).Count;
    }

    [Fact]
    public void ValidatingAMessageAddsNothingToTheGlobalRegistry()
    {
        // Warm both definitions first, so the count is taken once nothing is left to parse.
        ProcessorJsonSchemaValidator.TryValidate(Locator, Utf8("""{"location":"/a"}"""), out _);
        ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("""{"number":1}"""), out _);
        var before = GlobalRegistrations();

        for (var i = 0; i < 2_000; i++)
        {
            // Passing and failing data both: the failure path must not keep anything either.
            Assert.True(ProcessorJsonSchemaValidator.TryValidate(Locator, Utf8("""{"location":"/in/a.zip"}"""), out _));
            Assert.False(ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("""{"number":"x"}"""), out _));
        }

        // Before the fix this was 4,000: one registration per call.
        Assert.Equal(before, GlobalRegistrations());
    }

    [Fact]
    public void AFirstParseDoesNotRegisterGloballyEither()
    {
        // The cache alone would leave one global registration per distinct definition, held forever
        // even after the cache drops it. Parsing into the schema's own registry leaves none.
        var before = GlobalRegistrations();

        for (var i = 0; i < 20; i++)
        {
            var fresh = $$"""{"type":"object","required":["k{{i}}"]}""";
            Assert.False(ProcessorJsonSchemaValidator.TryValidate(fresh, Utf8("{}"), out _));
        }

        Assert.Equal(before, GlobalRegistrations());
    }

    [Fact]
    public void TheCacheIsBoundedAndStillRightPastTheBound()
    {
        var count = ProcessorJsonSchemaValidator.MaxCachedDefinitions * 3;

        for (var i = 0; i < count; i++)
        {
            var definition = $$"""{"type":"object","required":["k{{i}}"]}""";
            Assert.True(ProcessorJsonSchemaValidator.TryValidate(definition, Utf8($$"""{"k{{i}}":1}"""), out _));
            Assert.False(ProcessorJsonSchemaValidator.TryValidate(definition, Utf8("{}"), out _));
            Assert.InRange(ProcessorJsonSchemaValidator.CachedDefinitionCount, 1, ProcessorJsonSchemaValidator.MaxCachedDefinitions);
        }

        // A definition dropped from the cache is parsed again, with the same verdict.
        Assert.False(ProcessorJsonSchemaValidator.TryValidate("""{"type":"object","required":["k0"]}""", Utf8("{}"), out _));
    }

    [Fact]
    public void AnInvalidDefinitionIsNotCachedAndStaysABusinessFailure()
    {
        const string notASchema = "[1,2]";   // valid JSON, not a schema: FromText throws
        var cached = ProcessorJsonSchemaValidator.CachedDefinitionCount;
        var before = GlobalRegistrations();

        for (var i = 0; i < 50; i++)
        {
            Assert.False(ProcessorJsonSchemaValidator.TryValidate(notASchema, Utf8("{}"), out var errors));
            Assert.NotEmpty(errors);
        }

        Assert.True(ProcessorJsonSchemaValidator.CachedDefinitionCount <= cached);
        Assert.Equal(before, GlobalRegistrations());
    }

    [Fact]
    public async Task TheSchemasOwnRegistryFetchesNothing()
    {
        // The lockdown used to rest on SchemaRegistry.Global.Fetch alone. A schema now parses into a
        // registry of its own, which must refuse an outbound $ref just as firmly: a listener on
        // loopback that is never connected to shows no request was attempted.
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var ct = TestContext.Current.CancellationToken;
        var accept = listener.AcceptTcpClientAsync(ct).AsTask();

        var remote = $$"""{"$ref":"http://127.0.0.1:{{port}}/schema.json"}""";
        Assert.False(ProcessorJsonSchemaValidator.TryValidate(remote, Utf8("""{"number":7}"""), out var errors));
        Assert.NotEmpty(errors);

        var first = await Task.WhenAny(accept, Task.Delay(500, ct));
        Assert.NotSame(accept, first);
        listener.Stop();
    }

    [Fact]
    public async Task ASharedSchemaGivesEachConcurrentCallItsOwnVerdict()
    {
        // One parsed schema now serves every thread of a processor. Mixed passing and failing data,
        // in parallel, must get exactly the verdicts and errors a lone call gets.
        var cases = new (string Data, bool Valid)[]
        {
            ("""{"location":"/in/a.zip"}""", true),
            ("""{"location":""}""", false),
            ("""{"other":1}""", false),
            ("""{"location":"/x","extra":true}""", false),
        };
        var expected = cases.Select(c =>
        {
            ProcessorJsonSchemaValidator.TryValidate(Locator, Utf8(c.Data), out var e);
            return string.Join("|", e);
        }).ToArray();

        var mismatches = 0;
        await Parallel.ForAsync(0, 8_000, new ParallelOptions { MaxDegreeOfParallelism = 16 }, (i, _) =>
        {
            var k = i % cases.Length;
            var ok = ProcessorJsonSchemaValidator.TryValidate(Locator, Utf8(cases[k].Data), out var e);
            if (ok != cases[k].Valid || string.Join("|", e) != expected[k])
            {
                Interlocked.Increment(ref mismatches);
            }

            return ValueTask.CompletedTask;
        });

        Assert.Equal(0, mismatches);
    }
}
