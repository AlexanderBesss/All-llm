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
        SpeechEngines.Chatterbox or SpeechEngines.Qwen3Tts => IsLlmAvailable(backend),
        _ => false
    };

    private static bool IsLlmAvailable(BackendDefinition backend)
    {
        if (string.IsNullOrWhiteSpace(backend.ExecutablePath) || !File.Exists(backend.ExecutablePath))
            return false;
        var model = backend.ModelPath?.Trim() ?? string.Empty;
        if (model.Length == 0)
            return false;
        if (backend.Engine == SpeechEngines.Qwen3Tts && string.IsNullOrWhiteSpace(backend.VoiceName))
            return false;
        if (SpeechEngines.IsQwenVoiceClone(backend) &&
            (string.IsNullOrWhiteSpace(backend.Instruct) || !File.Exists(backend.VoiceName)))
            return false;
        if (SpeechEngines.IsChatterboxReferenceRequired(backend) &&
            (string.IsNullOrWhiteSpace(backend.VoiceName) || !File.Exists(backend.VoiceName)))
            return false;
        if (backend.Engine == SpeechEngines.Chatterbox &&
            !string.IsNullOrWhiteSpace(backend.VoiceName) && !File.Exists(backend.VoiceName))
            return false;
        if (Directory.Exists(model) || File.Exists(model))
            return true;
        if (Path.IsPathRooted(model) || model.Contains('\\'))
            return false;
        return true;
    }

    public static ReaderSettings CreateDefaults(string? dataDirectory = null)
    {
        var baseDirectory = dataDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TtsReader");
        return new ReaderSettings
        {
            ActiveBackendId = "windows-default",
            Backends = DefaultBackends(baseDirectory)
        };
    }

    private ReaderSettings Upgrade(ReaderSettings loaded)
    {
        var defaults = CreateDefaults(_root);
        foreach (var backend in defaults.Backends)
        {
            var previous = loaded.Backends.FirstOrDefault(item => item.Id == backend.Id);
            if (previous is null)
                continue;
            backend.VoiceName = previous.VoiceName ?? backend.VoiceName;
            backend.ExecutablePath = previous.ExecutablePath ?? backend.ExecutablePath;
            backend.ModelPath = previous.ModelPath ?? backend.ModelPath;
            backend.Variant = previous.Variant ?? backend.Variant;
            backend.Language = previous.Language ?? backend.Language;
            backend.Instruct = previous.Instruct ?? backend.Instruct;
        }

        defaults.ActiveBackendId = defaults.Backends.Any(item => item.Id == loaded.ActiveBackendId)
            ? loaded.ActiveBackendId
            : "windows-default";
        defaults.PlaybackRate = loaded.PlaybackRate;
        defaults.LastFolderPath = loaded.LastFolderPath;
        defaults.LastSelectedFilePath = loaded.LastSelectedFilePath;
        return defaults;
    }

    public static List<BackendDefinition> DefaultBackends(string baseDirectory) =>
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
            ExecutablePath = Path.Combine(baseDirectory, "piper", "Scripts", "piper.exe"),
            ModelPath = Path.Combine(baseDirectory, "piper", "voices", "en_US-lessac-medium.onnx")
        },
        new BackendDefinition
        {
            Id = "chatterbox-local",
            Name = "Chatterbox LLM voice",
            Kind = "Local LLM TTS (Chatterbox, Python)",
            BuiltIn = false,
            Engine = SpeechEngines.Chatterbox,
            ExecutablePath = Path.Combine(baseDirectory, "chatterbox", "Scripts", "python.exe"),
            ModelPath = "ResembleAI/chatterbox",
            Variant = "base"
        },
        new BackendDefinition
        {
            Id = "qwen3-tts-local",
            Name = "Qwen3-TTS LLM voice",
            Kind = "Local LLM TTS (Qwen3-TTS, Python)",
            BuiltIn = false,
            Engine = SpeechEngines.Qwen3Tts,
            ExecutablePath = Path.Combine(baseDirectory, "qwen3-tts", "Scripts", "python.exe"),
            ModelPath = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
            Variant = "custom-voice",
            VoiceName = "Ryan",
            Language = "English"
        }
    ];
}
