using BaseApi.Core.DependencyInjection;
using BaseApi.Service;
using BaseApi.Service.Features.Molecule;
using BaseApi.Service.Features.Processor;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Molecule;

/// <summary>
/// Pins the description <c>GET /model/fields</c> serves: the update validators' rules and the EF model's store types and
/// unique indexes, read at runtime. The model comes from a context configured for Npgsql (no connection); the
/// validators from the same assembly scan production uses.
/// </summary>
public sealed class ModelFieldsTests
{
    private static ModelFieldsSnapshot Snapshot()
    {
        using var sp = new ServiceCollection().AddBaseApiValidation(typeof(AppDbContext).Assembly).BuildServiceProvider();
        using var scope = sp.CreateScope();
        using var db = ModelRelationsTests.NpgsqlModelContext();
        return ModelFields.Build(db.Model, scope.ServiceProvider);
    }

    private static ModelEntityFieldsDto Entity(string table) => Snapshot().Dto.Entities.Single(e => e.Table == table);
    private static ModelFieldDto Field(string table, string field) => Entity(table).Fields.Single(f => f.Field == field);
    private static string[] Kinds(ModelFieldDto f) => f.Rules.Select(r => r.Value is null ? r.Kind : $"{r.Kind}:{r.Value}").ToArray();

    [Fact]
    public void DescribesEveryEntityTableAndNoLinkTable()
    {
        using var db = ModelRelationsTests.NpgsqlModelContext();
        var entityTables = ModelRelations.Describe(db.Model).Dto.Tables.Where(t => t.Kind == "entity").Select(t => t.Table);

        Assert.Equal(entityTables.Order(StringComparer.Ordinal), Snapshot().Dto.Entities.Select(e => e.Table));
    }

    [Fact]
    public void EveryUpdateDtoPropertyIsAFieldInOrder()
    {
        Assert.Equal(
            ["name", "version", "description", "sourceHash", "instanceId", "inputSchemaId", "outputSchemaId", "configSchemaId"],
            Entity("processors").Fields.Select(f => f.Field));
        Assert.Equal(typeof(ProcessorUpdateDto).GetProperties().Length, Entity("processors").Fields.Count);
    }

    [Fact]
    public void TheSharedRulesOfAnIncludedValidatorReachEveryEntity()
    {
        foreach (var e in Snapshot().Dto.Entities)
        {
            Assert.Equal(["required", "maxLength:200"], Kinds(e.Fields.Single(f => f.Field == "name")));
            Assert.Equal(["required", @"pattern:^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"], Kinds(e.Fields.Single(f => f.Field == "version")));
            Assert.Equal(["maxLength:2000"], Kinds(e.Fields.Single(f => f.Field == "description")));
            Assert.True(e.Fields.Single(f => f.Field == "description").Nullable);
            Assert.False(e.Fields.Single(f => f.Field == "name").Nullable);
        }
    }

    [Fact]
    public void DeclarativeRulesComeWithTheirValuesAndOwnMessages()
    {
        var hash = Field("processors", "sourceHash");
        Assert.Equal(["required", "pattern:^[a-f0-9]{64}$"], Kinds(hash));
        Assert.Null(hash.Rules[0].Message); // FluentValidation's default is left to the client
        Assert.Equal("SourceHash must be a lowercase SHA-256 hex string (64 chars, [a-f0-9]).", hash.Rules[1].Message);
        Assert.Equal("character varying(64)", hash.StoreType);

        Assert.Equal(["maxLength:200"], Kinds(Field("processors", "instanceId")));
        Assert.True(Field("processors", "instanceId").Nullable);
    }

    [Fact]
    public void ARuleInsideWhenHasValueIsConditionalOnTheFieldItself()
    {
        var input = Field("processors", "inputSchemaId");
        Assert.Equal("guid", input.Type);
        Assert.True(input.Nullable);
        var rule = Assert.Single(input.Rules);
        Assert.Equal(("notEqual", "00000000-0000-0000-0000-000000000000", true), (rule.Kind, rule.Value, rule.Conditional));
    }

    [Fact]
    public void AnEnumListsEveryValueAndTheRulesSayWhichIsRefused()
    {
        var condition = Field("steps", "entryCondition");
        Assert.Equal("enum", condition.Type);
        Assert.Equal(["enum", "notEqual:0"], Kinds(condition));
        Assert.Equal(
            [(0L, "PreviousProcessing"), (1L, "PreviousCompleted"), (2L, "PreviousFailed"), (3L, "PreviousCancelled"), (4L, "Always"), (5L, "Never")],
            condition.Values!.Select(v => (v.Value, v.Name)));
    }

    [Fact]
    public void ACodeRuleIsMarkedCodeWithItsOwnMessageOrNone()
    {
        Assert.Equal(["required", "code"], Kinds(Field("schemas", "definition")));
        Assert.Null(Field("schemas", "definition").Rules[1].Message); // Custom(...) reports its own failures; it has no message

        var cron = Assert.Single(Field("workflows", "cronExpression").Rules);
        Assert.Equal(("code", true), (cron.Kind, cron.Conditional));
        Assert.StartsWith("CronExpression must be a valid 5- or 6-field cron expression", cron.Message);
    }

    [Fact]
    public void JsonFieldsSayJsonbAndLinkListsHaveNoColumn()
    {
        Assert.Equal("jsonb", Field("schemas", "definition").StoreType);
        Assert.Equal("jsonb", Field("assignments", "payload").StoreType);
        Assert.Equal("jsonb", Field("caches", "items").StoreType);

        var next = Field("steps", "nextStepIds");
        Assert.Equal(("guid[]", (string?)null, (string?)null), (next.Type, next.Column, next.StoreType));
        Assert.Equal("processor_id", Field("steps", "processorId").Column);
    }

    [Fact]
    public void UniqueIndexesComeWithTheirFieldsAndFilters()
    {
        Assert.Equal(["uq_cache_root|root|"], Entity("caches").Unique.Select(Text));
        Assert.Equal(
            ["uq_processor_instance_id|sourceHash,instanceId|instance_id IS NOT NULL", "uq_processor_source_hash|sourceHash|instance_id IS NULL"],
            Entity("processors").Unique.Select(Text));
        Assert.Empty(Entity("schemas").Unique);
    }

    private static string Text(ModelUniqueDto u) => $"{u.Index}|{string.Join(",", u.Fields)}|{u.Filter}";

    [Fact]
    public void TheETagIsStableForTheSameRules()
    {
        Assert.Matches("^[0-9a-f]{16}$", Snapshot().ETag);
        Assert.Equal(Snapshot().ETag, Snapshot().ETag);
    }
}

public sealed class ModelFieldsControllerTests
{
    private static readonly ModelFieldsDto Fields = new([new ModelEntityFieldsDto("schemas", [], [])]);

    private static ModelFieldsController Controller(string? ifNoneMatch = null)
    {
        var reader = Substitute.For<IModelFieldsReader>();
        reader.Read().Returns(new ModelFieldsRead(Fields, "0123456789abcdef"));
        var http = new DefaultHttpContext();
        if (ifNoneMatch is not null) http.Request.Headers.IfNoneMatch = ifNoneMatch;
        return new ModelFieldsController(reader, Substitute.For<IModelChangesValidator>()) { ControllerContext = new ControllerContext { HttpContext = http } };
    }

    [Fact]
    public void TheFieldsComeWithAStrongETag()
    {
        var controller = Controller();

        var ok = Assert.IsType<OkObjectResult>(controller.Fields());

        Assert.Same(Fields, ok.Value);
        Assert.Equal("\"0123456789abcdef\"", controller.Response.Headers.ETag.ToString());
    }

    [Fact]
    public void AMatchingIfNoneMatchIsNotModified() =>
        Assert.Equal(StatusCodes.Status304NotModified, Assert.IsType<StatusCodeResult>(Controller("\"0123456789abcdef\"").Fields()).StatusCode);
}

public sealed class ModelValidateControllerTests
{
    private static (ModelFieldsController Controller, IModelChangesValidator Runner) Make()
    {
        var runner = Substitute.For<IModelChangesValidator>();
        var controller = new ModelFieldsController(Substitute.For<IModelFieldsReader>(), runner)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        return (controller, runner);
    }

    [Fact]
    public async Task TheChangesGoToTheDryRunInOrderAndItsAnswerComesBack()
    {
        var (controller, runner) = Make();
        var changes = new[] { new ModelChangeDto("update", "schemas", Guid.NewGuid(), null), new ModelChangeDto("delete", "caches", Guid.NewGuid(), null) };
        var answer = new ModelValidateResultDto(false, []);
        runner.DryRunAsync(Arg.Any<IReadOnlyList<ModelChangeDto>>(), Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(answer);

        var ok = Assert.IsType<OkObjectResult>(await controller.Validate(new ModelChangesDto(changes), TestContext.Current.CancellationToken));

        Assert.Same(answer, ok.Value);
        await runner.Received(1).DryRunAsync(Arg.Is<IReadOnlyList<ModelChangeDto>>(c => c.SequenceEqual(changes)), Arg.Any<HttpContext>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task NoChangesOrTooManyIsABadRequestAndNothingRuns()
    {
        var (controller, runner) = Make();
        var tooMany = Enumerable.Range(0, ModelChangeRunner.MaxChanges + 1).Select(_ => new ModelChangeDto("delete", "caches", Guid.NewGuid(), null)).ToList();

        Assert.Equal(400, Assert.IsType<ObjectResult>(await controller.Validate(new ModelChangesDto(null!), TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(400, Assert.IsType<ObjectResult>(await controller.Validate(new ModelChangesDto(tooMany), TestContext.Current.CancellationToken)).StatusCode);
        await runner.DidNotReceiveWithAnyArgs().DryRunAsync(default!, default!, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task TheApplyGetsTheChangesInOrderWithWhenEachRowWasReadAndItsAnswerComesBack()
    {
        var (controller, runner) = Make();
        var read = new DateTime(2026, 10, 17, 9, 30, 0, DateTimeKind.Utc);
        var made = Guid.NewGuid();
        var changes = new[] { new ModelChangeDto("create", "schemas", made, null), new ModelChangeDto("update", "steps", Guid.NewGuid(), null, read) };
        var answer = new ModelApplyResultDto(true, true, [], new Dictionary<Guid, Guid> { [made] = Guid.NewGuid() });
        runner.ApplyAsync(Arg.Any<IReadOnlyList<ModelChangeDto>>(), Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(answer);

        var ok = Assert.IsType<OkObjectResult>(await controller.Apply(new ModelChangesDto(changes), TestContext.Current.CancellationToken));

        Assert.Same(answer, ok.Value);
        await runner.Received(1).ApplyAsync(Arg.Is<IReadOnlyList<ModelChangeDto>>(c => c.SequenceEqual(changes) && c[1].UpdatedAt == read), Arg.Any<HttpContext>(), Arg.Any<CancellationToken>());
        await runner.DidNotReceiveWithAnyArgs().DryRunAsync(default!, default!, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task AnApplyOfNothingOrOfTooManyIsABadRequestAndNothingIsWritten()
    {
        var (controller, runner) = Make();
        var tooMany = Enumerable.Range(0, ModelChangeRunner.MaxChanges + 1).Select(_ => new ModelChangeDto("delete", "caches", Guid.NewGuid(), null)).ToList();

        Assert.Equal(400, Assert.IsType<ObjectResult>(await controller.Apply(new ModelChangesDto(null!), TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(400, Assert.IsType<ObjectResult>(await controller.Apply(new ModelChangesDto([]), TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(400, Assert.IsType<ObjectResult>(await controller.Apply(new ModelChangesDto(tooMany), TestContext.Current.CancellationToken)).StatusCode);
        await runner.DidNotReceiveWithAnyArgs().ApplyAsync(default!, default!, TestContext.Current.CancellationToken);
    }
}
