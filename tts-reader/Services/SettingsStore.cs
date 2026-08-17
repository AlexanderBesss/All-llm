using System.Text.Json;
using TtsReader.Models;

namespace TtsReader.Services;

public sealed class SettingsStore : ISettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    public string SettingsPath { get; }
    public string PackagesDirectory { get; }

    public SettingsStore(string? dataDirectory = null)
    {
        var root = dataDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TtsReader");
        SettingsPath = Path.Combine(root, "settings.json");
        PackagesDirectory = Path.Combine(root, "backends");
    }

    public ReaderSettings Load()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var loaded = JsonSerializer.Deserialize<ReaderSettings>(File.ReadAllText(SettingsPath), JsonOptions);
                if (loaded is { Backends.Count: > 0 })
                    return loaded;
            }
        }
        catch (JsonException)
        {
            // Invalid user settings are replaced by safe defaults.
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }

        return CreateDefaults();
    }

    public void Save(ReaderSettings settings)
    {
        var directory = Path.GetDirectoryName(SettingsPath)!;
        Directory.CreateDirectory(directory);
        var temporaryPath = SettingsPath + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(temporaryPath, SettingsPath, true);
    }

    public bool IsAvailable(BackendDefinition backend) =>
        backend.BuiltIn || (!string.IsNullOrWhiteSpace(backend.PackageFileName) &&
                            File.Exists(Path.Combine(PackagesDirectory, backend.PackageFileName)));

    public string GetPackagePath(BackendDefinition backend) =>
        Path.Combine(PackagesDirectory, backend.PackageFileName ?? $"{backend.Id}.package");

    public static ReaderSettings CreateDefaults() => new()
    {
        ActiveBackendId = "windows-default",
        Backends =
        [
            new BackendDefinition
            {
                Id = "windows-default",
                Name = "Windows default voice",
                Kind = "Windows Speech processor",
                BuiltIn = true
            },
            new BackendDefinition
            {
                Id = "downloaded-profile",
                Name = "Downloaded local voice profile",
                Kind = "Downloadable voice-model profile",
                BuiltIn = false,
                PackageFileName = "local-voice.profile",
                DownloadSource = new Uri(Path.Combine(AppContext.BaseDirectory,
                    "Profiles", "windows-natural.profile.json")).AbsoluteUri
            }
        ]
    };
}
