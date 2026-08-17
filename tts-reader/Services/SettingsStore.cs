using System.Text.Json;
using TtsReader.Models;

namespace TtsReader.Services;

public sealed class SettingsStore : ISettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private readonly string _root;
    public string SettingsPath { get; }

    public SettingsStore(string? dataDirectory = null)
    {
        _root = dataDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TtsReader");
        SettingsPath = Path.Combine(_root, "settings.json");
    }

    public ReaderSettings Load()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var loaded = JsonSerializer.Deserialize<ReaderSettings>(File.ReadAllText(SettingsPath), JsonOptions);
                if (loaded is { Backends.Count: > 0 })
                    return Upgrade(loaded);
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

        return CreateDefaults(_root);
    }

    public void Save(ReaderSettings settings)
    {
        var directory = Path.GetDirectoryName(SettingsPath)!;
        Directory.CreateDirectory(directory);
        var temporaryPath = SettingsPath + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(temporaryPath, SettingsPath, true);
    }

    public bool IsAvailable(BackendDefinition backend) => backend.Engine switch
    {
        SpeechEngines.Windows => backend.BuiltIn,
        SpeechEngines.Piper => File.Exists(backend.ExecutablePath) &&
                               File.Exists(backend.ModelPath) &&
                               File.Exists(backend.ModelPath + ".json"),
        _ => false
    };

    public static ReaderSettings CreateDefaults(string? dataDirectory = null)
    {
        var root = Path.Combine(dataDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TtsReader"), "piper");
        return new ReaderSettings
        {
            ActiveBackendId = "windows-default",
            Backends = DefaultBackends(root)
        };
    }

    private ReaderSettings Upgrade(ReaderSettings loaded)
    {
        var defaults = CreateDefaults(_root);
        var windows = loaded.Backends.FirstOrDefault(item => item.Id == "windows-default");
        if (windows is not null)
        {
            defaults.Backends[0].VoiceName = windows.VoiceName;
        }

        var piper = loaded.Backends.FirstOrDefault(item => item.Id == "piper-local");
        if (piper is not null)
        {
            defaults.Backends[1].ExecutablePath = piper.ExecutablePath;
            defaults.Backends[1].ModelPath = piper.ModelPath;
        }

        defaults.ActiveBackendId = defaults.Backends.Any(item => item.Id == loaded.ActiveBackendId)
            ? loaded.ActiveBackendId
            : "windows-default";
        defaults.PlaybackRate = loaded.PlaybackRate;
        defaults.LastFolderPath = loaded.LastFolderPath;
        defaults.LastSelectedFilePath = loaded.LastSelectedFilePath;
        return defaults;
    }

    private static List<BackendDefinition> DefaultBackends(string root) =>
        [
            new BackendDefinition
            {
                Id = "windows-default",
                Name = "Windows default voice",
                Kind = "Windows Speech processor",
                BuiltIn = true,
                Engine = SpeechEngines.Windows
            },
            new BackendDefinition
            {
                Id = "piper-local",
                Name = "Piper local neural voice",
                Kind = "Local Piper ONNX neural TTS",
                BuiltIn = false,
                Engine = SpeechEngines.Piper,
                ExecutablePath = Path.Combine(root, "Scripts", "piper.exe"),
                ModelPath = Path.Combine(root, "voices", "en_US-lessac-medium.onnx")
            }
        ];
}
