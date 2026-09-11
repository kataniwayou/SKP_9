using System.Text;
using System.Text.Json;
using Xunit;
using SK = Processor.SKNormalizer;
using CL = Processor.ArchiveCollapser;

namespace BaseApi.Tests.SKNormalizer;

/// <summary>
/// The contract is COPIED into this processor, as it is into the expander and the collapser. A copy
/// is only safe while it stays byte-compatible on the wire, so this asserts the bytes rather than
/// trusting that the copy was faithful. If someone edits one copy, this is what fails.
/// </summary>
public sealed class FileNodeContractTests
{
    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    [Fact]
    public void ADocumentSerializesIdenticallyToTheCollapsersCopy()
    {
        var sk = new SK.FileNode(
            new SK.FileMetadata("orders.zip", ".zip", 40219, Stamp, Stamp, 1),
            new SK.FileContent.Entries(
            [
                new SK.FileNode(
                    new SK.FileMetadata("a.csv", ".csv", 2, null, Stamp, 0),
                    new SK.FileContent.Bytes(Encoding.UTF8.GetBytes("id"))),
            ]));

        var cl = new CL.FileNode(
            new CL.FileMetadata("orders.zip", ".zip", 40219, Stamp, Stamp, 1),
            new CL.FileContent.Entries(
            [
                new CL.FileNode(
                    new CL.FileMetadata("a.csv", ".csv", 2, null, Stamp, 0),
                    new CL.FileContent.Bytes(Encoding.UTF8.GetBytes("id"))),
            ]));

        Assert.Equal(
            JsonSerializer.SerializeToUtf8Bytes(cl, CL.FileDocument.Options),
            JsonSerializer.SerializeToUtf8Bytes(sk, SK.FileDocument.Options));
    }

    [Fact]
    public void AnArchiveThatExpandedToNothingKeepsNullContent()
    {
        // content: null is the third form a node may take and is NOT an empty array. The converter
        // must round-trip it as null, because ArchiveBuilder treats null as "pack an empty archive".
        var node = new SK.FileNode(
            new SK.FileMetadata("empty.zip", ".zip", 22, null, Stamp, 0), null);

        var json = JsonSerializer.SerializeToUtf8Bytes(node, SK.FileDocument.Options);
        var back = JsonSerializer.Deserialize<SK.FileNode>(json, SK.FileDocument.Options);

        Assert.NotNull(back);
        Assert.Null(back!.Content);
    }
}
