using System.IO.Compression;

namespace TtsReader.Services;

public static class LlmRuntimeDependencies
{
    private const string SoxVersion = "14.4.2";

    public static bool IsSoxAvailable() => FindSoxPath() is not null;

    public static string? FindSoxDirectory()
    {
        var privatePath = TtsReaderPaths.SoxPath;
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
        var reporter = progress ?? LlmDownloadProgress.NoopProgress;
        if (IsSoxAvailable())
        {
            reporter.Report(new LlmDownloadProgress(endPercent, "SoX audio dependency is ready."));
            return;
        }

        var root = TtsReaderPaths.SoxRoot;
        var archivePath = Path.Combine(TtsReaderPaths.DownloadsRoot, $"sox-{SoxVersion}-win32.zip");
        Directory.CreateDirectory(TtsReaderPaths.DownloadsRoot);

        if (!File.Exists(archivePath))
        {
            reporter.Report(new LlmDownloadProgress(startPercent, "Downloading the SoX audio dependency…"));
            await HttpFileDownloader.DownloadFileAsync(
                GetDownloadUrl(),
                archivePath,
                startPercent,
                Math.Min(endPercent - 1, startPercent + (endPercent - startPercent) * 0.7),
                "Downloading the SoX audio dependency",
                reporter,
                cancellationToken);
        }

        reporter.Report(new LlmDownloadProgress(
            Math.Min(endPercent - 0.5, startPercent + (endPercent - startPercent) * 0.7),
            "Installing the SoX audio dependency…"));
        await ExtractAsync(archivePath, root, cancellationToken);

        if (!IsSoxAvailable())
            throw new InvalidOperationException("SoX was installed but its executable could not be found.");

        HttpFileDownloader.TryDelete(archivePath);
        reporter.Report(new LlmDownloadProgress(endPercent, "SoX audio dependency is ready."));
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

    private static string? FindSoxPath() =>
        FindSoxDirectory() is { } directory
            ? Path.Combine(directory, "sox.exe")
            : null;

    private static string GetDownloadUrl() =>
        $"https://sourceforge.net/projects/sox/files/sox/{SoxVersion}/sox-{SoxVersion}-win32.zip/download";
}
