using System.Text.Encodings.Web;
using System.Text.Json;
using BaseApi.Core.DependencyInjection;
using BaseApi.Service;
using BaseApi.Service.Features.Molecule;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace BaseApi.Tests.Molecule;

/// <summary>
/// Keeps Valence's bundled copy of <c>GET /model/fields</c> equal to what this BaseApi serves. Valence reads the rules
/// from BaseApi and falls back to the snapshot only when the endpoint is missing (an older BaseApi); this test is what
/// makes the snapshot generated rather than hand-kept: a changed validator or index fails it until it is regenerated.
/// <para>
/// To regenerate: run this test with <c>VALENCE_FIELDS_SNAPSHOT=write</c>.
/// </para>
/// </summary>
public sealed class ValenceFieldsSnapshotTests
{
    private const string RelativePath = "src/Valence/src/api/model-fields.snapshot.json";

    // Web defaults, as ASP.NET writes the response body; indented so the snapshot diffs line by line.
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    [Fact]
    public void ValencesSnapshotIsWhatThisBaseApiServes()
    {
        var root = RepoRoot();
        Assert.SkipWhen(root is null, "The Valence app is not in this checkout.");
        var path = Path.Combine(root!, RelativePath);

        using var sp = new ServiceCollection().AddBaseApiValidation(typeof(AppDbContext).Assembly).BuildServiceProvider();
        using var scope = sp.CreateScope();
        using var db = ModelRelationsTests.NpgsqlModelContext();
        var snapshot = ModelFields.Build(db.Model, scope.ServiceProvider);
        var expected = JsonSerializer.Serialize(new { etag = snapshot.ETag, entities = snapshot.Dto.Entities }, Json).ReplaceLineEndings("\n") + "\n";

        if (Environment.GetEnvironmentVariable("VALENCE_FIELDS_SNAPSHOT") == "write")
        {
            File.WriteAllText(path, expected);
            return;
        }

        Assert.True(File.Exists(path), $"{RelativePath} is missing: run this test with VALENCE_FIELDS_SNAPSHOT=write.");
        Assert.True(
            File.ReadAllText(path).ReplaceLineEndings("\n") == expected,
            $"{RelativePath} differs from GET /model/fields: run this test with VALENCE_FIELDS_SNAPSHOT=write.");
    }

    private static string? RepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, "src", "Valence", "src", "api"))) return dir.FullName;
        return null;
    }
}
