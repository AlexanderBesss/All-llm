using System.Net.Http.Headers;

namespace TtsReader.Services;

public static class HttpFileDownloader
{
    private static readonly HttpClient HttpClient = CreateClient();

    public static string FormatBytes(long bytes) =>
        $"{bytes / (1024d * 1024d):0.0} MB";

    public static async Task DownloadFileAsync(
        string url,
        string destinationPath,
        double startPercent,
        double endPercent,
        string stage,
        IProgress<LlmDownloadProgress> progress,
        CancellationToken cancellationToken)
    {
        var temporaryPath = destinationPath + ".partial";
        try
        {
            using var response = await HttpClient.GetAsync(
                url,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            response.EnsureSuccessStatusCode();

            await using (var input = await response.Content.ReadAsStreamAsync(cancellationToken))
            await using (var output = new FileStream(
                temporaryPath,
                FileMode.Create,
                FileAccess.Write,
                FileShare.None,
                64 * 1024,
                useAsync: true))
            {
                var totalBytes = response.Content.Headers.ContentLength;
                var downloadedBytes = 0L;
                var buffer = new byte[64 * 1024];
                var lastPercent = startPercent;
                int bytesRead;
                while ((bytesRead = await input.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    await output.WriteAsync(buffer.AsMemory(0, bytesRead), cancellationToken);
                    downloadedBytes += bytesRead;
                    var percent = totalBytes is > 0
                        ? startPercent + (downloadedBytes / (double)totalBytes.Value * (endPercent - startPercent))
                        : Math.Min(endPercent - 0.25, lastPercent + 0.25);
                    if (percent >= lastPercent + 0.25 || downloadedBytes == totalBytes)
                    {
                        lastPercent = percent;
                        progress.Report(new LlmDownloadProgress(
                            percent,
                            totalBytes is > 0
                                ? $"{stage}: {FormatBytes(downloadedBytes)}"
                                : $"{stage}…"));
                    }
                }
            }

            File.Move(temporaryPath, destinationPath, overwrite: true);
            progress.Report(new LlmDownloadProgress(endPercent, $"{stage} complete."));
        }
        catch
        {
            TryDelete(temporaryPath);
            throw;
        }
    }

    public static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("TtsReader", "1.0"));
        return client;
    }
}
