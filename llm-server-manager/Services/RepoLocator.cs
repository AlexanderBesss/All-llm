using System;
using System.IO;
using System.Text.Json;

namespace LlmServerManager.Services;

public static class RepoLocator
{
    public static string? FindFrom(string startDir)
    {
        DirectoryInfo? dir = null;
        try
        {
            dir = Directory.Exists(startDir) ? new DirectoryInfo(startDir) : null;
        }
        catch
        {
            return null;
        }

        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "llm-servers")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    public static string? LoadSettingsOverride()
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "settings.json");
            if (!File.Exists(path)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.TryGetProperty("repoRoot", out var element))
            {
                var value = element.GetString();
                return string.IsNullOrWhiteSpace(value) ? null : value;
            }
        }
        catch
        {
            return null;
        }
        return null;
    }

    public static void SaveSettingsOverride(string repoRoot)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "settings.json");
        var escaped = repoRoot.Replace("\\", "\\\\");
        File.WriteAllText(path, "{\n  \"repoRoot\": \"" + escaped + "\"\n}\n");
    }
}
