using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.Core;
using UglyToad.PdfPig.Fonts.Standard14Fonts;
using UglyToad.PdfPig.Writer;
using System.Windows.Documents;
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
    public async Task ReadAsync_PreservesMarkdownBlankLinesUnicodeAndFinalContent()
    {
        var path = Path.Combine(_root, "complete.MARKDOWN");
        const string expected = "# Привіт\n\nFirst paragraph.\n\n\n最後の行 ✓\n";
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

    [Fact]
    public void MarkdownRenderer_RendersFormattingAndTablesWithoutMarkdownSyntax()
    {
        const string markdown = "# Report\n\n**Important** and *emphasis*\n\n| Name | Value |\n| --- | ---: |\n| CPU | 42% |";

        var document = new MarkdownDocumentRenderer().Render(markdown);
        var rendered = new TextRange(document.ContentStart, document.ContentEnd).Text;

        Assert.Contains("Report", rendered);
        Assert.Contains("Important", rendered);
        Assert.Contains("emphasis", rendered);
        Assert.Contains("CPU", rendered);
        Assert.Contains("42%", rendered);
        Assert.DoesNotContain("**", rendered);
        Assert.DoesNotContain("| --- |", rendered);
        Assert.Contains(document.Blocks, block => block is Table);
    }

    [Fact]
    public void MarkdownRenderer_RendersRepresentativeBlocksInSourceOrder()
    {
        const string markdown = """
            Title
            =====

            Paragraph with **bold**, _emphasis_, [a link](https://example.test), and `inline code`.

            > Quoted text

            3. First ordered
            4. Second ordered

            - Unordered

            ```csharp
            Console.WriteLine("hello");
            ```

            ---

            | Name | Value |
            | :--- | ---: |
            | CPU | 42% |
            """;

        var document = new MarkdownDocumentRenderer().Render(markdown);
        var rendered = ReadDocument(document);

        AssertTextInOrder(rendered, "Title", "Paragraph with bold", "Quoted text", "First ordered",
            "Second ordered", "Unordered", "Console.WriteLine", "Name", "CPU", "42%");
        Assert.DoesNotContain("=====", rendered);
        Assert.DoesNotContain("**", rendered);
        Assert.DoesNotContain("```", rendered);
        Assert.DoesNotContain("| :--- |", rendered);
        Assert.Contains(document.Blocks, block => block is Section);
        Assert.Contains(document.Blocks, block => block is System.Windows.Documents.List);
        Assert.Contains(document.Blocks, block => block is Table);
    }

    [Theory]
    [InlineData("Before *unmatched\n\nAfter", "Before *unmatched", "After")]
    [InlineData("Before\n\n```text\nunclosed fence\nat end", "unclosed fence", "at end")]
    [InlineData("Before ![broken](<> invalid) After", "Before", "broken", "After")]
    public void MarkdownRenderer_MalformedInputKeepsReadableContent(string markdown, params string[] expected)
    {
        var rendered = ReadDocument(new MarkdownDocumentRenderer().Render(markdown, "bad\0path.md"));

        AssertTextInOrder(rendered, expected);
    }

    [Fact]
    public void MarkdownRenderer_ExternalAndMissingImagesUseReadableAltText()
    {
        const string markdown = "![Remote diagram](https://example.test/image.png) then ![Missing local](missing.png)";

        var rendered = ReadDocument(new MarkdownDocumentRenderer().Render(markdown, Path.Combine(_root, "readme.md")));

        Assert.Contains("[Image: Remote diagram]", rendered);
        Assert.Contains("[Image: Missing local]", rendered);
    }

    [Fact]
    public void MarkdownRenderer_LocalImageRendersAndKeepsAltTextForCaretAndSpeech()
    {
        var imagePath = Path.Combine(_root, "pixel.png");
        File.WriteAllBytes(imagePath, Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="));

        FlowDocument? document = null;
        RunOnSta(() => document = new MarkdownDocumentRenderer().Render(
            "Before ![Local pixel](pixel.png) after", Path.Combine(_root, "readme.md")));

        Assert.NotNull(document);
        var rendered = ReadDocument(document!);
        Assert.Contains("Before", rendered);
        Assert.Contains("[Image: Local pixel]", rendered);
        Assert.Contains("after", rendered);
        Assert.Contains(document!.Blocks.OfType<Paragraph>().SelectMany(paragraph => paragraph.Inlines),
            inline => inline is InlineUIContainer);
    }

    [Fact]
    public void MarkdownRenderer_RendersMermaidFlowchartAsVisualBlock()
    {
        const string markdown = "```mermaid\nflowchart LR\nA[Start] --> B[Finish]\n```";
        FlowDocument? document = null;
        var renderError = RunOnSta(() => document = new MarkdownDocumentRenderer().Render(markdown));

        Assert.Null(renderError);
        Assert.NotNull(document);
        Assert.Contains(document.Blocks, block => block is BlockUIContainer);
        var rendered = new TextRange(document.ContentStart, document.ContentEnd).Text;
        Assert.Contains("Diagram: Start, Finish", rendered);
    }

    private static string ReadDocument(FlowDocument document) =>
        new TextRange(document.ContentStart, document.ContentEnd).Text;

    private static void AssertTextInOrder(string actual, params string[] expected)
    {
        var previous = -1;
        foreach (var value in expected)
        {
            var current = actual.IndexOf(value, StringComparison.Ordinal);
            Assert.True(current > previous, $"Expected '{value}' after character {previous} in: {actual}");
            previous = current;
        }
    }

    private static Exception? RunOnSta(Action action)
    {
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception exception) { error = exception; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        return error;
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
            Directory.Delete(_root, true);
    }
}
