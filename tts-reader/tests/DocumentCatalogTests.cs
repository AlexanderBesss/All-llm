using TtsReader.Services;

namespace TtsReader.Tests;

public sealed class DocumentCatalogTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"tts-reader-catalog-{Guid.NewGuid():N}");

    [Fact]
    public void Build_PreservesFoldersAndIncludesOnlySupportedFiles()
    {
        Directory.CreateDirectory(Path.Combine(_root, "chapter", "notes"));
        File.WriteAllText(Path.Combine(_root, "readme.md"), "root");
        File.WriteAllText(Path.Combine(_root, "skip.docx"), "ignored");
        File.WriteAllText(Path.Combine(_root, "chapter", "one.txt"), "one");
        File.WriteAllText(Path.Combine(_root, "chapter", "notes", "paper.pdf"), "%PDF");

        var root = new DocumentCatalog().Build(_root);

        Assert.Equal(_root, root.Name);
        Assert.Contains(root.Children, item => !item.IsFolder && item.Name == "readme.md");
        Assert.DoesNotContain(root.Children, item => item.Name == "skip.docx");
        var chapter = Assert.Single(root.Children, item => item.IsFolder);
        Assert.Equal("chapter", chapter.Name);
        Assert.Contains(chapter.Children, item => item.Name == "one.txt");
        Assert.Contains(Assert.Single(chapter.Children, item => item.IsFolder).Children,
            item => item.Name == "paper.pdf");
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
            Directory.Delete(_root, true);
    }
}
