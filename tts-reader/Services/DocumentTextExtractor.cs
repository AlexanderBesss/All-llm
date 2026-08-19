using System.Text;
using UglyToad.PdfPig;

namespace TtsReader.Services;

public sealed class DocumentTextExtractor : IDocumentTextExtractor
{
    public async Task<string> ReadAsync(string path, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException("The selected file no longer exists.", path);

        if (DocumentFormats.IsPlainText(path))
            return await File.ReadAllTextAsync(path, cancellationToken);

        if (DocumentFormats.IsPdf(path))
            return await Task.Run(() => ReadPdf(path, cancellationToken), cancellationToken);

        throw new NotSupportedException($"Files of type '{Path.GetExtension(path)}' are not supported.");
    }

    private static string ReadPdf(string path, CancellationToken cancellationToken)
    {
        var text = new StringBuilder();
        using var document = PdfDocument.Open(path);
        foreach (var page in document.GetPages())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (text.Length > 0)
                text.AppendLine().AppendLine();
            text.Append(page.Text);
        }

        if (string.IsNullOrWhiteSpace(text.ToString()))
            throw new InvalidDataException("No selectable text was found in this PDF. Image-only PDFs require OCR, which is not supported.");

        return text.ToString();
    }
}
