using BaseApi.Service.Features.Molecule;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Molecule;

public sealed class MoleculeControllerTests
{
    private static readonly ModelRelationsDto Relations = new(
        [new ModelTableDto("steps", "entity", "name")],
        [new ModelRelationDto("fk_step_processor_id", "steps", "processor_id", "processors", "RESTRICT", false, 1, null)]);

    private static MoleculeController Controller(string? ifNoneMatch = null)
    {
        var relations = Substitute.For<IModelRelationsReader>();
        relations.Read().Returns(new ModelRelationsRead(Relations, "0123456789abcdef"));
        var http = new DefaultHttpContext();
        if (ifNoneMatch is not null) http.Request.Headers.IfNoneMatch = ifNoneMatch;
        return new MoleculeController(relations, Substitute.For<IMoleculeReader>())
        {
            ControllerContext = new ControllerContext { HttpContext = http },
        };
    }

    [Fact]
    public void TheRelationsComeWithAStrongETag()
    {
        var controller = Controller();

        var ok = Assert.IsType<OkObjectResult>(controller.Relations());

        Assert.Same(Relations, ok.Value);
        Assert.Equal("\"0123456789abcdef\"", controller.Response.Headers.ETag.ToString());
    }

    [Fact]
    public void AMatchingIfNoneMatchIsNotModified()
    {
        var status = Assert.IsType<StatusCodeResult>(Controller("\"0123456789abcdef\"").Relations());

        Assert.Equal(StatusCodes.Status304NotModified, status.StatusCode);
    }

    [Fact]
    public void AnOldETagGetsTheRelationsAgain()
    {
        Assert.IsType<OkObjectResult>(Controller("\"ffffffffffffffff\"").Relations());
    }
}
