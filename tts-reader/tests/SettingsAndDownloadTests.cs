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
        Assert.Equal(2, loaded.Backends.Count);
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
