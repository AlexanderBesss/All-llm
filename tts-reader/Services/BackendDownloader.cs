using System.Net.Http;
using TtsReader.Models;

namespace TtsReader.Services;

public sealed class BackendDownloader(HttpClient? httpClient = null) : IBackendDownloader
{
    private readonly HttpClient _httpClient = httpClient ?? new HttpClient();

    public async Task DownloadAsync(
        BackendDefinition backend,
        string destinationPath,
        IProgress<int>? progress = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(backend.DownloadSource))
            throw new InvalidOperationException("This backend has no configured download source.");

        var source = new Uri(backend.DownloadSource, UriKind.Absolute);
        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
        var partialPath = destinationPath + ".partial";

        try
        {
            await using var output = new FileStream(partialPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);
            if (source.IsFile)
            {
                await using var input = new FileStream(source.LocalPath, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, true);
                await CopyWithProgressAsync(input, output, input.Length, progress, cancellationToken);
            }
            else if (source.Scheme is "http" or "https")
            {
                using var response = await _httpClient.GetAsync(source, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
                response.EnsureSuccessStatusCode();
                await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
                await CopyWithProgressAsync(input, output, response.Content.Headers.ContentLength, progress, cancellationToken);
            }
            else
            {
                throw new NotSupportedException("Only file, HTTP, and HTTPS download sources are supported.");
            }

            await output.FlushAsync(cancellationToken);
            output.Close();
            if (new FileInfo(partialPath).Length == 0)
                throw new InvalidDataException("The downloaded backend package was empty.");
            File.Move(partialPath, destinationPath, true);
            progress?.Report(100);
        }
        catch
        {
            if (File.Exists(partialPath))
                File.Delete(partialPath);
            throw;
        }
    }

    private static async Task CopyWithProgressAsync(Stream input, Stream output, long? length, IProgress<int>? progress, CancellationToken token)
    {
        var buffer = new byte[81920];
        long copied = 0;
        int read;
        while ((read = await input.ReadAsync(buffer, token)) > 0)
        {
            await output.WriteAsync(buffer.AsMemory(0, read), token);
            copied += read;
            if (length > 0)
                progress?.Report((int)Math.Min(99, copied * 100 / length.Value));
        }
    }
}
