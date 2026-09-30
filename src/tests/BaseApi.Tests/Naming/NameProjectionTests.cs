using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class NameProjectionTests
{
    private static readonly Guid W  = Guid.Parse("11111111-1111-1111-aaaa-111111111111");
    private static readonly Guid S1 = Guid.Parse("22222222-2222-2222-bbbb-222222222222");
    private static readonly Guid S2 = Guid.Parse("33333333-3333-3333-cccc-333333333333");
    private static readonly Guid P  = Guid.Parse("44444444-4444-4444-dddd-444444444444");

    private static WorkflowGraphSnapshot Snapshot()
    {
        var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
        var now = DateTime.UtcNow;

        snapshot.Workflows[W] = new WorkflowReadDto(
            W, "chain", "1.0.0", null, [S1], [], [], null, now, now, null, null);
        snapshot.Steps[S1] = new StepReadDto(S1, "step-a", "1.0.0", null, P, [S2], default, now, now, null, null);
        snapshot.Steps[S2] = new StepReadDto(S2, "step-b", "2.0.0", null, P, [], default, now, now, null, null);
        snapshot.Processors[P] = new ProcessorReadDto(
            P, "shared-proc", "1.2.0", null, "hash", null, null, null, null, now, now, null, null);

        return snapshot;
    }

    [Fact]
    public void TheDefinitionNamesTheWorkflowAndEachStepButNoProcessor()
    {
        using var snapshot = Snapshot();

        var names = OrchestrationService.ToDefinitionForTests(snapshot, W).Names!;

        // Processors own their own name key now; BaseApi never writes one.
        Assert.Equal(3, names.Count);
        Assert.Equal(EntityNames.Format("chain", "1.0.0", W), names[W]);
        Assert.Equal(EntityNames.Format("step-b", "2.0.0", S2), names[S2]);
        Assert.False(names.ContainsKey(P));
    }

    [Fact]
    public async Task TheWriterPutsEachNameOnItsEntityHash()
    {
        using var snapshot = Snapshot();
        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);
        var l2 = new InMemoryL2();

        await new L2ProjectionWriter(l2.Multiplexer, new FakeTimeProvider()).WriteAsync(definition, CancellationToken.None);

        Assert.Equal(definition.Names![W], l2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.NameField));
        Assert.Equal(definition.Names![S1], l2.HashValue(L2ProjectionKeys.StepEntity(S1), L2ProjectionKeys.NameField));
        Assert.Equal(definition.Names![S2], l2.HashValue(L2ProjectionKeys.StepEntity(S2), L2ProjectionKeys.NameField));
        Assert.False(l2.HasHash(L2ProjectionKeys.Processor(P)));
    }

    [Fact]
    public async Task ANameForAnIdThatIsNeitherTheWorkflowNorOneOfItsStepsIsNotWritten()
    {
        var stranger = Guid.NewGuid();
        var l2 = new InMemoryL2();

        await new L2ProjectionWriter(l2.Multiplexer, new FakeTimeProvider())
            .WriteAsync(new WorkflowL1(W, [], null, [], [], new() { [stranger] = "x_1-0000-000000000000" }), CancellationToken.None);

        Assert.False(l2.HasHash(L2ProjectionKeys.StepEntity(stranger)));
        Assert.False(l2.HasHash(L2ProjectionKeys.Workflow(stranger)));
    }

    [Fact]
    public void NoProductionSourceScansTheKeySpace()
    {
        // Component 3's safety claim: the only KEYS/SCAN in production code is the orphan sweeper's
        // skp:proc:* pattern, which cannot match skp:name:*.
        //
        // WIDENED past the plan's single "exactly one hit" check: the property this test pins is
        // "nothing scans a pattern matching skp:name:*", not "exactly one call site". A second sweeper
        // copy that also scans skp:proc:* should still pass; only a hit that DOESN'T reference that
        // pattern should fail. The matcher covers `Keys(`/`KeysAsync(` calls (excluding the false
        // positives a bare "KeysAsync(" substring would catch, such as ListIndexKeysAsync's own
        // declaration/implementation/call site, via a negative lookbehind for a preceding letter) plus
        // the raw RESP command literals "SCAN" and "KEYS", so a hand-rolled RESP scan would be caught
        // too, not just a StackExchange.Redis call.
        var src = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var scanCall = new System.Text.RegularExpressions.Regex(@"(?<![A-Za-z])Keys(Async)?\(");
        var hits = Directory.EnumerateFiles(src, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}")
                        && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                        && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .SelectMany(f => File.ReadLines(f).Select(l => (f, l)))
            .Where(t => scanCall.IsMatch(t.l)
                        || t.l.Contains("\"SCAN\"", StringComparison.Ordinal)
                        || t.l.Contains("\"KEYS\"", StringComparison.Ordinal))
            .ToList();

        Assert.NotEmpty(hits);

        // ADAPTED from the brief: the pattern is built as $"{L2ProjectionKeys.Prefix}proc:*", not the
        // literal string "skp:proc:*" -- Prefix is "skp:" (see L2ProjectionKeys), so this resolves to
        // exactly that pattern at runtime. Checked against the interpolation's own source text rather
        // than its resolved value, which a source scan cannot evaluate.
        Assert.All(hits, t => Assert.Contains("Prefix}proc:*:instances", t.l, StringComparison.Ordinal));
    }
}
