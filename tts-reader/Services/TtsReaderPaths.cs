namespace TtsReader.Services;

public static class TtsReaderPaths
{
    public static string AppDataRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TtsReader");

    public static string SettingsPath => Path.Combine(AppDataRoot, "settings.json");

    public static string ScriptsRoot => Path.Combine(AppDataRoot, "scripts");

    public static string DownloadsRoot => Path.Combine(AppDataRoot, "downloads");

    public static string SoxRoot => Path.Combine(AppDataRoot, "sox");

    public static string SoxPath => Path.Combine(SoxRoot, "sox.exe");

    public static string PythonRuntimeRoot => Path.Combine(AppDataRoot, "python-runtime");

    public static string PythonRuntimePath => Path.Combine(PythonRuntimeRoot, "python.exe");

    public static string TempRoot => Path.Combine(Path.GetTempPath(), "TtsReader");

    public static string LogsRoot => Path.Combine(AppDataRoot, "logs");

    public static string VenvPythonPath(string environmentName) =>
        Path.Combine(AppDataRoot, environmentName, "Scripts", "python.exe");

    public static void CleanupStaleTempDirs(TimeSpan olderThan)
    {
        try
        {
            if (!Directory.Exists(TempRoot))
                return;
            var cutoff = DateTime.UtcNow - olderThan;
            foreach (var directory in Directory.EnumerateDirectories(TempRoot))
            {
                if (Directory.GetLastWriteTimeUtc(directory) < cutoff)
                    Directory.Delete(directory, recursive: true);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
