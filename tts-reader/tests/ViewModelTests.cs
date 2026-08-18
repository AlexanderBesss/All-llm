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

        await viewModel.OpenFolderAsync("library");
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
    public async Task MainViewModel_RemembersFolderAndSelectedFile()
    {
        var file = new DocumentNode { Name = "story.txt", FullPath = "library\\story.txt", IsFolder = false };
        var root = new DocumentNode { Name = "library", FullPath = "library", IsFolder = true };
        root.Children.Add(file);
        var store = new FakeStore(SettingsStore.CreateDefaults());
        using var viewModel = new MainWindowViewModel(
            new FakeCatalog(root), new FakeExtractor("text"), store, new FakeSpeech(),
            new FakeInteractions());

        await viewModel.OpenFolderAsync("library");
        viewModel.SelectedDocument = file;

        Assert.NotNull(store.Saved);
        Assert.Equal("library", store.Saved!.LastFolderPath);
        Assert.Equal(file.FullPath, store.Saved.LastSelectedFilePath);
    }

    [Fact]
    public async Task MainViewModel_RestoresLastFolderAndSelectedFile()
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

        await viewModel.RestoreLastSessionAsync();

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
    public void MainViewModel_SurfacesSynthesizingStatusOnlyWhilePlaying()
    {
        var speech = new FakeSpeech();
        using var viewModel = new MainWindowViewModel(
            new FakeCatalog(new DocumentNode { Name = "root", IsFolder = true }),
            new FakeExtractor("text"), new FakeStore(SettingsStore.CreateDefaults()), speech,
            new FakeInteractions());
        viewModel.SetRenderedText("read me");
        viewModel.PlayCommand.Execute(null);

        speech.RaiseStatus("Synthesizing chunk 1 of 2…");
        Assert.Equal("Synthesizing chunk 1 of 2…", viewModel.Status);

        viewModel.StopCommand.Execute(null);
        speech.RaiseStatus("Synthesizing chunk 2 of 2…");
        Assert.Contains("stopped", viewModel.Status, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void MainViewModel_StopCommandStopsActivePlayback()
    {
        var speech = new FakeSpeech();
        using var viewModel = new MainWindowViewModel(
            new FakeCatalog(new DocumentNode { Name = "root", IsFolder = true }),
            new FakeExtractor("read me"), new FakeStore(SettingsStore.CreateDefaults()), speech,
            new FakeInteractions());
        viewModel.SetRenderedText("read me");

        viewModel.PlayCommand.Execute(null);
        Assert.True(viewModel.StopCommand.CanExecute(null));

        viewModel.StopCommand.Execute(null);

        Assert.False(viewModel.IsPlaying);
        Assert.False(viewModel.StopCommand.CanExecute(null));
        Assert.Equal(1, speech.StopCount);
        Assert.Contains("stopped", viewModel.Status, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void MainViewModel_ReportsUnavailableBackendWithoutStartingPlayback()
    {
        var settings = SettingsStore.CreateDefaults();
        settings.ActiveBackendId = "piper-local";
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
    public async Task MainViewModel_DoesNotApplyDocumentSelectedDuringFolderScan()
    {
        var oldFile = new DocumentNode { Name = "old.txt", FullPath = "old.txt", IsFolder = false };
        var newRoot = new DocumentNode { Name = "new", FullPath = "new", IsFolder = true };
        var catalog = new CoordinatedCatalog(newRoot);
        var extractor = new DeferredExtractor();
        using var viewModel = new MainWindowViewModel(
            catalog, extractor, new FakeStore(SettingsStore.CreateDefaults()), new FakeSpeech(),
            new FakeInteractions());

        var folderLoad = viewModel.OpenFolderAsync("new");
        await catalog.ScanStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var documentLoad = viewModel.LoadDocumentAsync(oldFile);

        catalog.AllowScan();
        await folderLoad;
        extractor.Complete("stale document");
        await documentLoad;

        Assert.Same(newRoot, Assert.Single(viewModel.Documents));
        Assert.False(extractor.WasCalled);
        Assert.Null(viewModel.RenderedDocument.SourcePath);
        Assert.Empty(viewModel.RenderedDocument.Text);
    }

    [Fact]
    public void SettingsViewModel_ConfiguresActivatesAndPersistsPiper()
    {
        var settings = SettingsStore.CreateDefaults();
        settings.PlaybackRate = 1.25;
        settings.LastFolderPath = "library";
        settings.LastSelectedFilePath = "library\\story.txt";
        var store = new FakeStore(settings);
        using var viewModel = new SettingsWindowViewModel(store, settings);
        viewModel.SelectedBackend = viewModel.Backends.Single(row => row.Id == "piper-local");
        viewModel.SelectedExecutablePath = " C:\\Piper\\piper.exe ";
        viewModel.SelectedModelPath = " C:\\Piper\\voice.onnx ";

        viewModel.ActivateCommand.Execute(null);
        viewModel.SaveCommand.Execute(null);

        Assert.True(viewModel.SelectedBackend.IsActive);
        Assert.True(viewModel.SelectedBackend.IsAvailable);
        Assert.NotNull(store.Saved);
        Assert.Equal("piper-local", store.Saved!.ActiveBackendId);
        var saved = store.Saved.Backends.Single(backend => backend.Id == "piper-local");
        Assert.Equal("C:\\Piper\\piper.exe", saved.ExecutablePath);
        Assert.Equal("C:\\Piper\\voice.onnx", saved.ModelPath);
        Assert.Equal(1.25, store.Saved.PlaybackRate);
        Assert.Equal("library", store.Saved.LastFolderPath);
        Assert.Equal("library\\story.txt", store.Saved.LastSelectedFilePath);
    }

    [Fact]
    public void SettingsViewModel_ReportsSaveFailures()
    {
        var settings = SettingsStore.CreateDefaults();
        var store = new FakeStore(settings, available: false) { SaveError = new IOException("disk full") };
        using var viewModel = new SettingsWindowViewModel(store, settings);
        viewModel.SelectedBackend = viewModel.Backends.Single(row => row.Id == "piper-local");

        viewModel.SaveCommand.Execute(null);
        Assert.Contains("disk full", viewModel.Status);
        Assert.Null(viewModel.ResultSettings);
    }

    [Fact]
    public void SettingsViewModel_DownloadsUnavailableLlmAndUpdatesProgress()
    {
        var settings = SettingsStore.CreateDefaults();
        var store = new DownloadStore();
        var downloader = new FakeLlmDownloader();
        using var viewModel = new SettingsWindowViewModel(store, settings, downloader);
        var row = viewModel.Backends.Single(item => item.Id == "chatterbox-local");

        Assert.True(row.ShowDownload);
        viewModel.DownloadCommand.Execute(row);

        Assert.Equal(1, downloader.CallCount);
        Assert.True(row.IsAvailable);
        Assert.False(row.ShowDownload);
        Assert.Equal(100, row.DownloadProgress);
        Assert.Equal("Ready", row.DownloadStatus);
        Assert.Contains("ready", viewModel.Status, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class FakeCatalog(DocumentNode root) : IDocumentCatalog
    {
        public DocumentNode Build(string rootPath, CancellationToken cancellationToken = default) => root;
    }

    private sealed class CoordinatedCatalog(DocumentNode root) : IDocumentCatalog
    {
        public TaskCompletionSource<bool> ScanStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _allowScan =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public DocumentNode Build(string rootPath, CancellationToken cancellationToken = default)
        {
            ScanStarted.TrySetResult(true);
            _allowScan.Task.Wait(cancellationToken);
            return root;
        }

        public void AllowScan() => _allowScan.TrySetResult(true);
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

    private sealed class DeferredExtractor : IDocumentTextExtractor
    {
        private readonly TaskCompletionSource<string> _completion =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool WasCalled { get; private set; }

        public Task<string> ReadAsync(string path, CancellationToken cancellationToken = default)
        {
            WasCalled = true;
            return _completion.Task;
        }

        public void Complete(string text) => _completion.TrySetResult(text);
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
    }

    private sealed class DownloadStore : ISettingsStore
    {
        public ReaderSettings Load() => SettingsStore.CreateDefaults();
        public void Save(ReaderSettings settings) { }
        public bool IsAvailable(BackendDefinition backend) => backend.BuiltIn || backend.ExecutablePath == "installed";
    }

    private sealed class FakeLlmDownloader : ILlmBackendDownloader
    {
        public int CallCount { get; private set; }

        public Task DownloadAsync(
            BackendDefinition backend,
            IProgress<LlmDownloadProgress> progress,
            CancellationToken cancellationToken)
        {
            CallCount++;
            backend.ExecutablePath = "installed";
            progress.Report(new LlmDownloadProgress(45, "Installing package…"));
            progress.Report(new LlmDownloadProgress(100, "Download complete."));
            return Task.CompletedTask;
        }
    }

    private sealed class FakeSpeech : ISpeechPlaybackService
    {
        public List<(string Text, int Caret, BackendDefinition Backend, double PlaybackRate)> Calls { get; } = [];
        public int StopCount { get; private set; }
        public event EventHandler<string>? PlaybackEnded;
        public event EventHandler<SpeechProgressEventArgs>? PlaybackProgress;
        public event EventHandler<string>? PlaybackStatus;
        public void Speak(string text, int caretIndex, BackendDefinition backend, double playbackRate) =>
            Calls.Add((text, caretIndex, backend, playbackRate));
        public void Stop() => StopCount++;
        public void Dispose() { }
    public void Complete(string status) => PlaybackEnded?.Invoke(this, status);
    public void ReportProgress(int characterIndex, int characterCount) =>
        PlaybackProgress?.Invoke(this, new SpeechProgressEventArgs(characterIndex, characterCount));
    public void RaiseStatus(string status) => PlaybackStatus?.Invoke(this, status);
    }

    private sealed class FakeInteractions : IMainViewInteractions
    {
        public string? ChooseFolder() => null;
        public ReaderSettings? EditSettings(ReaderSettings settings) => null;
    }

}
