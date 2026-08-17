using System.IO.Compression;
using System.Net.Http.Headers;

namespace TtsReader.Services;

public static class LlmRuntimeDependencies
{
    private const string SoxVersion = "14.4.2";
    private static readonly HttpClient HttpClient = CreateHttpClient();

    public static bool IsSoxAvailable() => FindSoxPath() is not null;

    public static string? FindSoxDirectory()
    {
        var privatePath = GetPrivateSoxPath();
        if (File.Exists(privatePath))
            return Path.GetDirectoryName(privatePath);

        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var soxPath = Path.Combine(directory.Trim('"'), "sox.exe");
            if (File.Exists(soxPath))
                return Path.GetDirectoryName(soxPath);
        }

        return null;
    }

    public static async Task EnsureSoxAsync(
        IProgress<LlmDownloadProgress>? progress,
        double startPercent,
        double endPercent,
        CancellationToken cancellationToken)
    {
        if (IsSoxAvailable())
        {
            progress?.Report(new LlmDownloadProgress(endPercent, "SoX audio dependency is ready."));
            return;
        }

        var root = GetPrivateSoxRoot();
        var downloadsRoot = Path.Combine(GetAppDataRoot(), "downloads");
        var archivePath = Path.Combine(downloadsRoot, $"sox-{SoxVersion}-win32.zip");
        Directory.CreateDirectory(downloadsRoot);

        if (!File.Exists(archivePath))
        {
            progress?.Report(new LlmDownloadProgress(startPercent, "Downloading the SoX audio dependency…"));
            await DownloadFileAsync(
                GetDownloadUrl(),
                archivePath,
                startPercent,
                Math.Min(endPercent - 1, startPercent + (endPercent - startPercent) * 0.7),
                progress,
                cancellationToken);
        }

        progress?.Report(new LlmDownloadProgress(
            Math.Min(endPercent - 0.5, startPercent + (endPercent - startPercent) * 0.7),
            "Installing the SoX audio dependency…"));
        await ExtractAsync(archivePath, root, cancellationToken);

        if (!IsSoxAvailable())
            throw new InvalidOperationException("SoX was installed but its executable could not be found.");

        progress?.Report(new LlmDownloadProgress(endPercent, "SoX audio dependency is ready."));
    }

    private static async Task ExtractAsync(
        string archivePath,
        string destinationRoot,
        CancellationToken cancellationToken)
    {
        var stagingRoot = Path.Combine(
            Path.GetDirectoryName(destinationRoot)!,
            $"sox-extract-{Guid.NewGuid():N}");
        try
        {
            Directory.CreateDirectory(stagingRoot);
            await Task.Run(
                () => ZipFile.ExtractToDirectory(archivePath, stagingRoot, overwriteFiles: true),
                cancellationToken);

            var sourceExecutable = Directory
                .EnumerateFiles(stagingRoot, "sox.exe", SearchOption.AllDirectories)
                .FirstOrDefault();
            if (sourceExecutable is null)
                throw new InvalidDataException("The SoX archive did not contain sox.exe.");

            var sourceRoot = Path.GetDirectoryName(sourceExecutable)!;
            Directory.CreateDirectory(destinationRoot);
            foreach (var sourceFile in Directory.EnumerateFiles(sourceRoot, "*", SearchOption.AllDirectories))
            {
                cancellationToken.ThrowIfCancellationRequested();
                var relativePath = Path.GetRelativePath(sourceRoot, sourceFile);
                var destinationPath = Path.Combine(destinationRoot, relativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
                File.Copy(sourceFile, destinationPath, overwrite: true);
            }
        }
        finally
        {
            try
            {
                if (Directory.Exists(stagingRoot))
                    Directory.Delete(stagingRoot, recursive: true);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static async Task DownloadFileAsync(
        string url,
        string destinationPath,
        double startPercent,
        double endPercent,
        IProgress<LlmDownloadProgress>? progress,
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
                        ? startPercent + downloadedBytes / (double)totalBytes.Value * (endPercent - startPercent)
                        : Math.Min(endPercent - 0.25, lastPercent + 0.25);
                    if (percent >= lastPercent + 0.25 || downloadedBytes == totalBytes)
                    {
                        lastPercent = percent;
                        progress?.Report(new LlmDownloadProgress(percent, "Downloading SoX audio dependency…"));
                    }
                }
            }

            File.Move(temporaryPath, destinationPath, overwrite: true);
        }
        catch
        {
            TryDelete(temporaryPath);
            throw;
        }
    }

    private static string? FindSoxPath() =>
        FindSoxDirectory() is { } directory
            ? Path.Combine(directory, "sox.exe")
            : null;

    private static HttpClient CreateHttpClient()
    {
        var client = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("TtsReader", "1.0"));
        return client;
    }

    private static string GetAppDataRoot() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TtsReader");

    private static string GetPrivateSoxRoot() => Path.Combine(GetAppDataRoot(), "sox");

    private static string GetPrivateSoxPath() => Path.Combine(GetPrivateSoxRoot(), "sox.exe");

    private static string GetDownloadUrl() =>
        $"https://sourceforge.net/projects/sox/files/sox/{SoxVersion}/sox-{SoxVersion}-win32.zip/download";

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
