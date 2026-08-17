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
        settings.ActiveBackendId = "downloaded-profile";
        settings.Backends[1].DownloadSource = "https://example.test/voice.profile";
        settings.LastFolderPath = "C:\\Documents";
        settings.LastSelectedFilePath = "C:\\Documents\\story.md";

        store.Save(settings);
        var loaded = store.Load();

        Assert.Equal("downloaded-profile", loaded.ActiveBackendId);
        Assert.Equal(2, loaded.Backends.Count);
        Assert.Equal("https://example.test/voice.profile", loaded.Backends[1].DownloadSource);
        Assert.Equal(settings.LastFolderPath, loaded.LastFolderPath);
        Assert.Equal(settings.LastSelectedFilePath, loaded.LastSelectedFilePath);
    }

    [Fact]
    public async Task DownloadAsync_UsesPartialFileAndMarksAvailableOnlyAfterSuccess()
    {
        Directory.CreateDirectory(_root);
        var source = Path.Combine(_root, "source.profile");
        await File.WriteAllTextAsync(source, "voice profile content");
        var store = new SettingsStore(Path.Combine(_root, "data"));
        var backend = new BackendDefinition
        {
            Id = "test", Name = "Test", Kind = "Profile", PackageFileName = "test.profile",
            DownloadSource = new Uri(source).AbsoluteUri
        };
        Assert.False(store.IsAvailable(backend));

        await new BackendDownloader().DownloadAsync(backend, store.GetPackagePath(backend));

        Assert.True(store.IsAvailable(backend));
        Assert.Equal("voice profile content", await File.ReadAllTextAsync(store.GetPackagePath(backend)));
        Assert.False(File.Exists(store.GetPackagePath(backend) + ".partial"));
    }

    [Fact]
    public async Task DownloadAsync_FailureDoesNotCreateAvailablePackage()
    {
        var store = new SettingsStore(_root);
        var backend = new BackendDefinition
        {
            Id = "test", Name = "Test", Kind = "Profile", PackageFileName = "test.profile",
            DownloadSource = new Uri(Path.Combine(_root, "missing.profile")).AbsoluteUri
        };

        await Assert.ThrowsAsync<FileNotFoundException>(() =>
            new BackendDownloader().DownloadAsync(backend, store.GetPackagePath(backend)));

        Assert.False(store.IsAvailable(backend));
        Assert.False(File.Exists(store.GetPackagePath(backend) + ".partial"));
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
            Directory.Delete(_root, true);
    }
}
