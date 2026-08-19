using TtsReader.Models;
using TtsReader.Services;

namespace TtsReader.Tests;

public sealed class SettingsAndDownloadTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"tts-reader-settings-{Guid.NewGuid():N}");

    [Fact]
    public void SaveAndLoad_PersistsBackendsAndActiveSelection()
    {
        var store = new SettingsStore(_root);
        var settings = SettingsStore.CreateDefaults();
        settings.ActiveBackendId = "piper-local";
        settings.Backends[1].ExecutablePath = "C:\\Piper\\piper.exe";
        settings.Backends[1].ModelPath = "C:\\Piper\\voice.onnx";
        settings.PlaybackRate = 1.25;
        settings.LastFolderPath = "C:\\Documents";
        settings.LastSelectedFilePath = "C:\\Documents\\story.md";

        store.Save(settings);
        var loaded = store.Load();

        Assert.Equal("piper-local", loaded.ActiveBackendId);
        Assert.Equal(4, loaded.Backends.Count);
        Assert.Equal("C:\\Piper\\piper.exe", loaded.Backends[1].ExecutablePath);
        Assert.Equal("C:\\Piper\\voice.onnx", loaded.Backends[1].ModelPath);
        Assert.Equal(1.25, loaded.PlaybackRate);
        Assert.Equal(settings.LastFolderPath, loaded.LastFolderPath);
        Assert.Equal(settings.LastSelectedFilePath, loaded.LastSelectedFilePath);
    }

    [Fact]
    public void PiperAvailability_RequiresExecutableModelAndModelConfiguration()
    {
        var executable = Path.Combine(_root, "piper.exe");
        var model = Path.Combine(_root, "voice.onnx");
        var backend = new BackendDefinition
        {
            Id = "test", Name = "Test", Kind = "Piper", Engine = SpeechEngines.Piper,
            ExecutablePath = executable, ModelPath = model
        };
        var store = new SettingsStore(Path.Combine(_root, "data"));
        Assert.False(store.IsAvailable(backend));

        Directory.CreateDirectory(_root);
        File.WriteAllText(executable, "exe");
        File.WriteAllText(model, "model");
        Assert.False(store.IsAvailable(backend));
        File.WriteAllText(model + ".json", "{}");
        Assert.True(store.IsAvailable(backend));
    }

    [Fact]
    public void CreateDefaults_IncludesLocalLlmBackendsWithHuggingFaceModels()
    {
        var settings = SettingsStore.CreateDefaults("C:\\DataRoot");

        var chatterbox = settings.Backends.Single(item => item.Id == "chatterbox-local");
        Assert.Equal(SpeechEngines.Chatterbox, chatterbox.Engine);
        Assert.Equal(Path.Combine("C:\\DataRoot", "chatterbox", "Scripts", "python.exe"), chatterbox.ExecutablePath);
        Assert.Equal("ResembleAI/chatterbox", chatterbox.ModelPath);
        Assert.Equal("base", chatterbox.Variant);

        var qwen3 = settings.Backends.Single(item => item.Id == "qwen3-tts-local");
        Assert.Equal(SpeechEngines.Qwen3Tts, qwen3.Engine);
        Assert.Equal(Path.Combine("C:\\DataRoot", "qwen3-tts", "Scripts", "python.exe"), qwen3.ExecutablePath);
        Assert.Equal("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", qwen3.ModelPath);
        Assert.Equal("custom-voice", qwen3.Variant);
        Assert.Equal("Ryan", qwen3.VoiceName);
        Assert.Equal("English", qwen3.Language);
    }

    [Fact]
    public void LlmAvailability_RequiresPythonExecutableAndModelOrRepoId()
    {
        var store = new SettingsStore(Path.Combine(_root, "data"));
        Directory.CreateDirectory(_root);
        var executable = Path.Combine(_root, "python.exe");
        var localModel = Path.Combine(_root, "model");

        var backend = new BackendDefinition
        {
            Id = "chatterbox", Name = "Chatterbox", Kind = "LLM", Engine = SpeechEngines.Chatterbox,
            ExecutablePath = executable, ModelPath = "ResembleAI/chatterbox", Variant = "base"
        };
        Assert.False(store.IsAvailable(backend));
        File.WriteAllText(executable, "python");
        Assert.True(store.IsAvailable(backend));

        backend.ModelPath = localModel;
        Assert.False(store.IsAvailable(backend));
        Directory.CreateDirectory(localModel);
        Assert.True(store.IsAvailable(backend));
    }

    [Fact]
    public void Qwen3Availability_RequiresVoiceName()
    {
        var store = new SettingsStore(Path.Combine(_root, "data"));
        Directory.CreateDirectory(_root);
        var executable = Path.Combine(_root, "python.exe");
        File.WriteAllText(executable, "python");

        var backend = new BackendDefinition
        {
            Id = "qwen", Name = "Qwen3-TTS", Kind = "LLM", Engine = SpeechEngines.Qwen3Tts,
            ExecutablePath = executable, ModelPath = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
            Variant = "custom-voice"
        };
        Assert.False(store.IsAvailable(backend));
        backend.VoiceName = "Ryan";
        Assert.True(store.IsAvailable(backend));
    }

    [Fact]
    public void Qwen3CloneAvailability_RequiresReferenceAudioAndTranscript()
    {
        var store = new SettingsStore(Path.Combine(_root, "data"));
        Directory.CreateDirectory(_root);
        var executable = Path.Combine(_root, "python.exe");
        var reference = Path.Combine(_root, "reference.wav");
        File.WriteAllText(executable, "python");

        var backend = new BackendDefinition
        {
            Id = "qwen", Name = "Qwen3-TTS", Kind = "LLM", Engine = SpeechEngines.Qwen3Tts,
            ExecutablePath = executable, ModelPath = "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            Variant = "voice-clone", VoiceName = reference
        };

        Assert.False(store.IsAvailable(backend));
        File.WriteAllText(reference, "wav");
        Assert.False(store.IsAvailable(backend));
        backend.Instruct = "Reference transcript.";
        Assert.True(store.IsAvailable(backend));
    }

    [Fact]
    public void Load_ReturnsSafeDefaultsWhenTheSavedFileIsCorrupted()
    {
        Directory.CreateDirectory(_root);
        File.WriteAllText(Path.Combine(_root, "settings.json"), "{ this is not valid json");
        var store = new SettingsStore(_root);

        var loaded = store.Load();

        Assert.Equal("windows-default", loaded.ActiveBackendId);
        Assert.Equal(4, loaded.Backends.Count);
    }

    [Fact]
    public void Validation_ReportsTheSpecificMissingConfiguration()
    {
        var executable = Path.Combine(_root, "piper.exe");
        var model = Path.Combine(_root, "voice.onnx");
        Directory.CreateDirectory(_root);
        File.WriteAllText(executable, "exe");
        File.WriteAllText(model, "model");

        var piper = new BackendDefinition
        {
            Id = "piper", Name = "Piper", Kind = "Piper", Engine = SpeechEngines.Piper,
            ExecutablePath = executable, ModelPath = model
        };
        Assert.Contains(".onnx.json", BackendValidation.GetErrorMessage(piper));

        File.WriteAllText(model + ".json", "{}");
        Assert.Null(BackendValidation.GetErrorMessage(piper));

        var llm = new BackendDefinition
        {
            Id = "llm", Name = "LLM", Kind = "LLM", Engine = SpeechEngines.Qwen3Tts,
            ExecutablePath = Path.Combine(_root, "python.exe"), ModelPath = "org/model"
        };
        Assert.Contains("Python executable was not found", BackendValidation.GetErrorMessage(llm));

        File.WriteAllText(llm.ExecutablePath, "python");
        Assert.Contains("speaker name", BackendValidation.GetErrorMessage(llm));

        llm.VoiceName = "Ryan";
        Assert.Null(BackendValidation.GetErrorMessage(llm));

        llm.Variant = "voice-clone";
        Assert.Contains("reference .wav", BackendValidation.GetErrorMessage(llm));

        var reference = Path.Combine(_root, "reference.wav");
        File.WriteAllText(reference, "wav");
        llm.VoiceName = reference;
        Assert.Contains("reference transcript", BackendValidation.GetErrorMessage(llm));

        llm.Instruct = "Transcript.";
        Assert.Null(BackendValidation.GetErrorMessage(llm));
    }

    [Fact]
    public void IsAvailable_RejectsUnsupportedEngine()
    {
        var store = new SettingsStore(Path.Combine(_root, "data"));
        var backend = new BackendDefinition
        {
            Id = "future", Name = "Future", Kind = "Unknown", Engine = "future-engine",
            ExecutablePath = "C:\\python.exe", ModelPath = "org/model"
        };

        Assert.False(store.IsAvailable(backend));
    }

    [Fact]
    public void Load_UpgradesMetadataOnlyProfileToWindowsBackend()
    {
        var store = new SettingsStore(_root);
        var legacy = new ReaderSettings
        {
            ActiveBackendId = "downloaded-profile",
            Backends =
            [
                new BackendDefinition { Id = "windows-default", Name = "Windows", Kind = "Windows", BuiltIn = true },
                new BackendDefinition { Id = "downloaded-profile", Name = "Profile", Kind = "Profile" }
            ]
        };
        store.Save(legacy);

        var loaded = store.Load();

        Assert.Equal("windows-default", loaded.ActiveBackendId);
        Assert.Contains(loaded.Backends, item => item.Id == "piper-local" && item.Engine == SpeechEngines.Piper);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
            Directory.Delete(_root, true);
    }
}
