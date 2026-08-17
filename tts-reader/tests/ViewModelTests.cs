using TtsReader.Models;
using TtsReader.Services;
using TtsReader.ViewModels;

namespace TtsReader.Tests;

public sealed class ViewModelTests
{
    [Fact]
    public async Task MainViewModel_OpensLoadsPlaysAndRestartsFromMovedCaret()
    {
        var file = new DocumentNode { Name = "story.md", FullPath = "story.md", IsFolder = false };
        var root = new DocumentNode { Name = "library", FullPath = "library", IsFolder = true };
        root.Children.Add(file);
        var speech = new FakeSpeech();
        var store = new FakeStore(SettingsStore.CreateDefaults());
        using var viewModel = new MainWindowViewModel(
            new FakeCatalog(root), new FakeExtractor("# Story\nRead this"), store, speech,
            new FakeInteractions());

        viewModel.OpenFolder("library");
        await viewModel.LoadDocumentAsync(file);
        viewModel.SetRenderedText("Story\nRead this");
        viewModel.PlayCommand.Execute(null);
        viewModel.UpdateCaret(6);

        Assert.Same(root, Assert.Single(viewModel.Documents));
        Assert.True(viewModel.RenderedDocument.IsMarkdown);
        Assert.False(viewModel.IsLoading);
        Assert.True(viewModel.IsPlaying);
        Assert.Equal(2, speech.Calls.Count);
        Assert.Equal("Story\nRead this", speech.Calls[0].Text);
        Assert.DoesNotContain("#", speech.Calls[0].Text);
        Assert.Equal(6, speech.Calls[1].Caret);
        Assert.Contains("Caret moved", viewModel.Status);
    }

    [Fact]
    public void MainViewModel_ChangingPlaybackRateRestartsFromCurrentCaret()
    {
        var speech = new FakeSpeech();
        using var viewModel = new MainWindowViewModel(
            new FakeCatalog(new DocumentNode { Name = "root", IsFolder = true }),
            new FakeExtractor("text"), new FakeStore(SettingsStore.CreateDefaults()), speech,
            new FakeInteractions());
        viewModel.SetRenderedText("read me");

        viewModel.PlayCommand.Execute(null);
        viewModel.UpdateCaret(4);
        viewModel.PlaybackRate = 1.5;

        Assert.Equal(3, speech.Calls.Count);
        Assert.Equal(4, speech.Calls[2].Caret);
        Assert.Equal(1.5, speech.Calls[2].PlaybackRate);
    }

    [Fact]
    public void MainViewModel_RemembersFolderAndSelectedFile()
    {
        var file = new DocumentNode { Name = "story.txt", FullPath = "library\\story.txt", IsFolder = false };
        var root = new DocumentNode { Name = "library", FullPath = "library", IsFolder = true };
        root.Children.Add(file);
        var store = new FakeStore(SettingsStore.CreateDefaults());
        using var viewModel = new MainWindowViewModel(
            new FakeCatalog(root), new FakeExtractor("text"), store, new FakeSpeech(),
            new FakeInteractions());

        viewModel.OpenFolder("library");
        viewModel.SelectedDocument = file;

        Assert.NotNull(store.Saved);
        Assert.Equal("library", store.Saved!.LastFolderPath);
        Assert.Equal(file.FullPath, store.Saved.LastSelectedFilePath);
    }

    [Fact]
    public void MainViewModel_RestoresLastFolderAndSelectedFile()
    {
        var file = new DocumentNode { Name = "story.txt", FullPath = "library\\story.txt", IsFolder = false };
        var root = new DocumentNode { Name = "library", FullPath = "library", IsFolder = true };
        root.Children.Add(file);
        var settings = SettingsStore.CreateDefaults();
        settings.LastFolderPath = "library";
        settings.LastSelectedFilePath = file.FullPath;
        using var viewModel = new MainWindowViewModel(
            new FakeCatalog(root), new FakeExtractor("text"), new FakeStore(settings), new FakeSpeech(),
            new FakeInteractions());

        viewModel.RestoreLastSession();

        Assert.Same(file, viewModel.SelectedDocument);
        Assert.Equal("library", viewModel.Settings.LastFolderPath);
        Assert.Equal(file.FullPath, viewModel.Settings.LastSelectedFilePath);
    }

    [Fact]
    public void MainViewModel_TracksSpeechProgressAsCaretPosition()
    {
        var speech = new FakeSpeech();
        using var viewModel = new MainWindowViewModel(
            new FakeCatalog(new DocumentNode { Name = "root", IsFolder = true }),
            new FakeExtractor("text"), new FakeStore(SettingsStore.CreateDefaults()), speech,
            new FakeInteractions());
        viewModel.SetRenderedText("read me");

        viewModel.PlayCommand.Execute(null);
        speech.ReportProgress(4, 2);

        Assert.Equal(4, viewModel.PlaybackIndex);
        Assert.Equal(2, viewModel.PlaybackCharacterCount);
        Assert.Equal(4, viewModel.CaretIndex);
    }

    [Fact]
    public void MainViewModel_ReportsUnavailableBackendWithoutStartingPlayback()
    {
        var settings = SettingsStore.CreateDefaults();
        settings.ActiveBackendId = "downloaded-profile";
        var speech = new FakeSpeech();
        using var viewModel = new MainWindowViewModel(
            new FakeCatalog(new DocumentNode { Name = "root", IsFolder = true }),
            new FakeExtractor("text"), new FakeStore(settings, available: false), speech,
            new FakeInteractions());
        viewModel.SetRenderedText("read me");

        viewModel.PlayCommand.Execute(null);

        Assert.Empty(speech.Calls);
        Assert.Contains("unavailable", viewModel.Status, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task MainViewModel_CancelsInFlightDocumentLoad()
    {
        var extractor = new BlockingExtractor();
        using var viewModel = new MainWindowViewModel(
            new FakeCatalog(new DocumentNode { Name = "root", IsFolder = true }), extractor,
            new FakeStore(SettingsStore.CreateDefaults()), new FakeSpeech(), new FakeInteractions());
        var file = new DocumentNode { Name = "slow.txt", FullPath = "slow.txt", IsFolder = false };

        var load = viewModel.LoadDocumentAsync(file);
        Assert.True(viewModel.IsLoading);
        viewModel.CancelLoadingCommand.Execute(null);
        await load;

        Assert.False(viewModel.IsLoading);
        Assert.Contains("canceled", viewModel.Status, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task SettingsViewModel_EditsActivatesDownloadsAndPersists()
    {
        var settings = SettingsStore.CreateDefaults();
        settings.PlaybackRate = 1.25;
        settings.LastFolderPath = "library";
        settings.LastSelectedFilePath = "library\\story.txt";
        var store = new FakeStore(settings, available: false);
        var downloader = new FakeDownloader();
        using var viewModel = new SettingsWindowViewModel(store, downloader, settings);
        viewModel.SelectedBackend = viewModel.Backends.Single(row => row.Id == "downloaded-profile");
        viewModel.SelectedSource = " https://example.test/profile ";
        viewModel.SelectedVoice = " Test Voice ";

        viewModel.ActivateCommand.Execute(null);
        await viewModel.DownloadSelectedAsync();
        viewModel.SaveCommand.Execute(null);

        Assert.True(viewModel.SelectedBackend.IsActive);
        Assert.True(viewModel.SelectedBackend.IsAvailable);
        Assert.Equal(100, viewModel.DownloadProgress);
        Assert.NotNull(store.Saved);
        Assert.Equal("downloaded-profile", store.Saved!.ActiveBackendId);
        var saved = store.Saved.Backends.Single(backend => backend.Id == "downloaded-profile");
        Assert.Equal("https://example.test/profile", saved.DownloadSource);
        Assert.Equal("Test Voice", saved.VoiceName);
        Assert.Equal(1.25, store.Saved.PlaybackRate);
        Assert.Equal("library", store.Saved.LastFolderPath);
        Assert.Equal("library\\story.txt", store.Saved.LastSelectedFilePath);
    }

    [Fact]
    public async Task SettingsViewModel_ReportsDownloadAndSaveFailures()
    {
        var settings = SettingsStore.CreateDefaults();
        var store = new FakeStore(settings, available: false) { SaveError = new IOException("disk full") };
        using var viewModel = new SettingsWindowViewModel(store,
            new FakeDownloader(new InvalidOperationException("network down")), settings);
        viewModel.SelectedBackend = viewModel.Backends.Single(row => row.Id == "downloaded-profile");

        await viewModel.DownloadSelectedAsync();
        Assert.Contains("network down", viewModel.Status);

        viewModel.SaveCommand.Execute(null);
        Assert.Contains("disk full", viewModel.Status);
        Assert.Null(viewModel.ResultSettings);
    }

    private sealed class FakeCatalog(DocumentNode root) : IDocumentCatalog
    {
        public DocumentNode Build(string rootPath) => root;
    }

    private sealed class FakeExtractor(string text) : IDocumentTextExtractor
    {
        public Task<string> ReadAsync(string path, CancellationToken cancellationToken = default) => Task.FromResult(text);
    }

    private sealed class BlockingExtractor : IDocumentTextExtractor
    {
        public async Task<string> ReadAsync(string path, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return string.Empty;
        }
    }

    private sealed class FakeStore : ISettingsStore
    {
        private readonly ReaderSettings _settings;
        private readonly bool _available;
        public ReaderSettings? Saved { get; private set; }
        public Exception? SaveError { get; set; }

        public FakeStore(ReaderSettings settings, bool available = true)
        {
            _settings = settings;
            _available = available;
        }

        public ReaderSettings Load() => _settings;
        public void Save(ReaderSettings settings)
        {
            if (SaveError is not null) throw SaveError;
            Saved = settings;
        }
        public bool IsAvailable(BackendDefinition backend) => backend.BuiltIn || _available;
        public string GetPackagePath(BackendDefinition backend) => backend.PackageFileName ?? backend.Id;
    }

    private sealed class FakeSpeech : ISpeechPlaybackService
    {
        public List<(string Text, int Caret, BackendDefinition Backend, double PlaybackRate)> Calls { get; } = [];
        public event EventHandler<string>? PlaybackEnded;
        public event EventHandler<SpeechProgressEventArgs>? PlaybackProgress;
        public void Speak(string text, int caretIndex, BackendDefinition backend, double playbackRate) =>
            Calls.Add((text, caretIndex, backend, playbackRate));
        public void Stop() { }
        public void Dispose() { }
        public void Complete(string status) => PlaybackEnded?.Invoke(this, status);
        public void ReportProgress(int characterIndex, int characterCount) =>
            PlaybackProgress?.Invoke(this, new SpeechProgressEventArgs(characterIndex, characterCount));
    }

    private sealed class FakeInteractions : IMainViewInteractions
    {
        public string? ChooseFolder() => null;
        public ReaderSettings? EditSettings(ReaderSettings settings) => null;
    }

    private sealed class FakeDownloader(Exception? error = null) : IBackendDownloader
    {
        public Task DownloadAsync(BackendDefinition backend, string destinationPath,
            IProgress<int>? progress = null, CancellationToken cancellationToken = default)
        {
            if (error is not null) throw error;
            progress?.Report(100);
            return Task.CompletedTask;
        }
    }
}
