using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.Core;
using UglyToad.PdfPig.Fonts.Standard14Fonts;
using UglyToad.PdfPig.Writer;
using TtsReader.Services;

namespace TtsReader.Tests;

public sealed class DocumentTextExtractorTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"tts-reader-extract-{Guid.NewGuid():N}");

    public DocumentTextExtractorTests() => Directory.CreateDirectory(_root);

    [Theory]
    [InlineData("example.txt")]
    [InlineData("example.md")]
    [InlineData("example.markdown")]
    public async Task ReadAsync_ReturnsCompleteText(string fileName)
    {
        var path = Path.Combine(_root, fileName);
        const string expected = "Heading\r\n\r\nFull readable content ✓";
        await File.WriteAllTextAsync(path, expected);

        var actual = await new DocumentTextExtractor().ReadAsync(path);

        Assert.Equal(expected, actual);
    }

    [Fact]
    public async Task ReadAsync_ExtractsPdfPagesInOrder()
    {
        var builder = new PdfDocumentBuilder();
        var font = builder.AddStandard14Font(Standard14Font.Helvetica);
        var pageOne = builder.AddPage(PageSize.A4);
        pageOne.AddText("First page", 12, new PdfPoint(50, 750), font);
        var pageTwo = builder.AddPage(PageSize.A4);
        pageTwo.AddText("Second page", 12, new PdfPoint(50, 750), font);
        var path = Path.Combine(_root, "pages.pdf");
        await File.WriteAllBytesAsync(path, builder.Build());

        var actual = await new DocumentTextExtractor().ReadAsync(path);

        Assert.True(actual.IndexOf("First page", StringComparison.Ordinal) < actual.IndexOf("Second page", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ReadAsync_RejectsUnsupportedFilesClearly()
    {
        var path = Path.Combine(_root, "example.docx");
        await File.WriteAllTextAsync(path, "content");

        var error = await Assert.ThrowsAsync<NotSupportedException>(() => new DocumentTextExtractor().ReadAsync(path));

        Assert.Contains("not supported", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
            Directory.Delete(_root, true);
    }
}
