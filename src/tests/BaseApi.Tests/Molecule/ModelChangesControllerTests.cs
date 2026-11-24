using BaseApi.Service.Features.Molecule;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Molecule;

/// <summary><c>POST /model/validate</c> and <c>/model/apply</c>: Acto's board Save hands its change set to the runner.</summary>
public sealed class ModelChangesControllerTests
{
    private static (ModelChangesController Controller, IModelChangesValidator Runner) Make()
    {
        var runner = Substitute.For<IModelChangesValidator>();
        var controller = new ModelChangesController(runner)
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
