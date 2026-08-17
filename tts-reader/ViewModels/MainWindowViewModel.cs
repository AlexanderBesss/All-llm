using System.Collections.ObjectModel;
using System.Windows.Input;
using TtsReader.Models;
using TtsReader.Services;

namespace TtsReader.ViewModels;

public sealed class MainWindowViewModel : ViewModel, IDisposable
{
    private readonly IDocumentCatalog _catalog;
    private readonly IDocumentTextExtractor _extractor;
    private readonly ISettingsStore _settingsStore;
    private readonly ISpeechPlaybackService _speech;
    private readonly IMainViewInteractions _interactions;
    private readonly SynchronizationContext? _synchronizationContext;
    private ReaderSettings _settings;
    private DocumentNode? _selectedDocument;
    private RenderedDocument _renderedDocument = new(string.Empty, null, false);
    private string _renderedText = string.Empty;
    private string _status = "Choose a folder to begin.";
    private string _backendStatus = string.Empty;
    private bool _isLoading;
    private bool _isPlaying;
    private double _playbackRate;
    private int _caretIndex;
    private int _playbackIndex = -1;
    private int _playbackCharacterCount;
    private CancellationTokenSource? _loadCancellation;
    private bool _disposed;

    public ObservableCollection<DocumentNode> Documents { get; } = [];

    public DocumentNode? SelectedDocument
    {
        get => _selectedDocument;
        set
        {
            if (SetProperty(ref _selectedDocument, value) && value is { IsFolder: false })
                SelectDocumentCommand.Execute(value);
        }
    }

    public RenderedDocument RenderedDocument
    {
        get => _renderedDocument;
        private set => SetProperty(ref _renderedDocument, value);
    }

    public string Status { get => _status; private set => SetProperty(ref _status, value); }
    public string BackendStatus { get => _backendStatus; private set => SetProperty(ref _backendStatus, value); }

    public bool IsLoading
    {
        get => _isLoading;
        private set
        {
            if (!SetProperty(ref _isLoading, value)) return;
            CancelLoadingCommand.RaiseCanExecuteChanged();
            SelectDocumentCommand.RaiseCanExecuteChanged();
        }
    }

    public bool IsPlaying
    {
        get => _isPlaying;
        private set
        {
            if (!SetProperty(ref _isPlaying, value)) return;
            PlayCommand.RaiseCanExecuteChanged();
            StopCommand.RaiseCanExecuteChanged();
        }
    }

    public int CaretIndex { get => _caretIndex; private set => SetProperty(ref _caretIndex, value); }
    private static IReadOnlyList<PlaybackSpeedOption> AvailablePlaybackSpeeds { get; } =
    [
        new(1.0, "1.0×"),
        new(1.25, "1.25×"),
        new(1.5, "1.5×")
    ];

    public IReadOnlyList<PlaybackSpeedOption> PlaybackSpeeds => AvailablePlaybackSpeeds;

    public double PlaybackRate
    {
        get => _playbackRate;
        set
        {
            var normalized = NormalizePlaybackRate(value);
            if (!SetProperty(ref _playbackRate, normalized))
                return;
            _settings.PlaybackRate = normalized;
            TrySaveSettings();
            if (IsPlaying)
                StartFromCaret(true);
        }
    }

    public int PlaybackIndex { get => _playbackIndex; private set => SetProperty(ref _playbackIndex, value); }
    public int PlaybackCharacterCount
    {
        get => _playbackCharacterCount;
        private set => SetProperty(ref _playbackCharacterCount, value);
    }
    public ReaderSettings Settings => CloneSettings(_settings);

    public RelayCommand OpenFolderCommand { get; }
    public AsyncRelayCommand SelectDocumentCommand { get; }
    public RelayCommand PlayCommand { get; }
    public RelayCommand StopCommand { get; }
    public RelayCommand OpenSettingsCommand { get; }
    public RelayCommand CancelLoadingCommand { get; }

    public MainWindowViewModel(
        IDocumentCatalog catalog,
        IDocumentTextExtractor extractor,
        ISettingsStore settingsStore,
        ISpeechPlaybackService speech,
        IMainViewInteractions interactions,
        SynchronizationContext? synchronizationContext = null)
    {
        _catalog = catalog;
        _extractor = extractor;
        _settingsStore = settingsStore;
        _speech = speech;
        _interactions = interactions;
        _synchronizationContext = synchronizationContext ?? SynchronizationContext.Current;
        _settings = settingsStore.Load();
        _playbackRate = NormalizePlaybackRate(_settings.PlaybackRate);
        _settings.PlaybackRate = _playbackRate;

        OpenFolderCommand = new RelayCommand(_ => OpenFolder());
        SelectDocumentCommand = new AsyncRelayCommand(
            parameter => LoadDocumentAsync((DocumentNode)parameter!),
            parameter => parameter is DocumentNode { IsFolder: false, FullPath: not null },
            exception => Status = $"Could not load the document: {exception.Message}");
        PlayCommand = new RelayCommand(_ => StartFromCaret(false), _ => !IsPlaying);
        StopCommand = new RelayCommand(_ => StopPlayback("Playback stopped."), _ => IsPlaying);
        OpenSettingsCommand = new RelayCommand(_ => OpenSettings());
        CancelLoadingCommand = new RelayCommand(_ => CancelLoading(), _ => IsLoading);

        _speech.PlaybackEnded += SpeechPlaybackEnded;
        _speech.PlaybackProgress += SpeechPlaybackProgress;
        RefreshBackendStatus();
    }

    public void OpenFolder(string folderPath)
        => OpenFolderCore(folderPath, null, restoringSession: false);

    public void RestoreLastSession()
    {
        if (string.IsNullOrWhiteSpace(_settings.LastFolderPath))
            return;

        OpenFolderCore(_settings.LastFolderPath, _settings.LastSelectedFilePath, restoringSession: true);
    }

    private void OpenFolderCore(string folderPath, string? selectedFilePath, bool restoringSession)
    {
        StopPlayback("Playback stopped.");
        DetachAndCancelLoad();
        try
        {
            var root = _catalog.Build(folderPath);
            Documents.Clear();
            Documents.Add(root);
            SelectedDocument = null;
            RenderedDocument = new RenderedDocument(string.Empty, null, false);
            SetRenderedText(string.Empty);

            _settings.LastFolderPath = folderPath;
            if (!restoringSession)
                _settings.LastSelectedFilePath = null;
            var saveError = TrySaveSettings();

            Status = root.Children.Count == 0
                ? $"No supported .txt, .md, .markdown, or .pdf files were found in {folderPath}."
                : $"Browsing {folderPath}";

            if (saveError is not null)
                Status += $" Session could not be saved: {saveError}";

            if (restoringSession && !string.IsNullOrWhiteSpace(selectedFilePath))
            {
                var selected = FindDocument(root, selectedFilePath);
                if (selected is not null)
                    SelectedDocument = selected;
                else
                    Status += $" Saved file was not found: {selectedFilePath}";
            }
        }
        catch (Exception exception)
        {
            Status = $"Could not open the folder: {exception.Message}";
        }
    }

    public async Task LoadDocumentAsync(DocumentNode file)
    {
        if (file.IsFolder || file.FullPath is null)
            return;

        StopPlayback("Playback stopped.");
        _settings.LastSelectedFilePath = file.FullPath;
        TrySaveSettings();
        CancelCurrentLoad(setStatus: false);
        var cancellation = new CancellationTokenSource();
        _loadCancellation = cancellation;
        IsLoading = true;
        Status = $"Loading {file.Name}...";

        try
        {
            var text = await _extractor.ReadAsync(file.FullPath, cancellation.Token);
            cancellation.Token.ThrowIfCancellationRequested();
            var markdown = IsMarkdown(file.FullPath);
            _renderedText = text;
            RenderedDocument = new RenderedDocument(text, file.FullPath, markdown);
            CaretIndex = 0;
            Status = string.IsNullOrWhiteSpace(text)
                ? $"{file.Name} is empty."
                : markdown
                    ? $"Rendered {file.Name} ({_renderedText.Length:N0} readable characters)."
                    : $"Loaded {file.Name} ({text.Length:N0} characters).";
        }
        catch (OperationCanceledException)
        {
            if (ReferenceEquals(_loadCancellation, cancellation))
                Status = $"Loading {file.Name} was canceled.";
        }
        catch (Exception exception)
        {
            if (ReferenceEquals(_loadCancellation, cancellation))
            {
                RenderedDocument = new RenderedDocument(string.Empty, null, false);
                SetRenderedText(string.Empty);
                Status = $"Could not load {file.Name}: {exception.Message}";
            }
        }
        finally
        {
            if (ReferenceEquals(_loadCancellation, cancellation))
            {
                _loadCancellation = null;
                IsLoading = false;
            }
            cancellation.Dispose();
        }
    }

    public void SetRenderedText(string text)
    {
        _renderedText = text ?? string.Empty;
        if (CaretIndex > _renderedText.Length)
            CaretIndex = _renderedText.Length;
    }

    public void UpdateCaret(int caretIndex)
    {
        var bounded = Math.Clamp(caretIndex, 0, _renderedText.Length);
        if (bounded == CaretIndex)
            return;
        CaretIndex = bounded;
        if (IsPlaying)
            StartFromCaret(true);
    }

    public void CancelLoading()
    {
        if (!IsLoading)
            return;
        CancelCurrentLoad(setStatus: true);
    }

    private void OpenFolder()
    {
        try
        {
            var folder = _interactions.ChooseFolder();
            if (!string.IsNullOrWhiteSpace(folder))
                OpenFolder(folder);
        }
        catch (Exception exception)
        {
            Status = $"Could not open the folder picker: {exception.Message}";
        }
    }

    private void StartFromCaret(bool isRestart)
    {
        if (string.IsNullOrWhiteSpace(_renderedText))
        {
            Status = "Load a non-empty document before starting playback.";
            return;
        }

        var backend = ActiveBackend();
        if (backend is null)
        {
            Status = "The active speech backend is missing from settings.";
            return;
        }
        if (!_settingsStore.IsAvailable(backend))
        {
            Status = $"'{backend.Name}' is unavailable. Open Settings to configure it or select another backend.";
            return;
        }

        try
        {
            _speech.Speak(_renderedText, CaretIndex, backend, PlaybackRate);
            IsPlaying = true;
            PlaybackCharacterCount = 1;
            PlaybackIndex = CaretIndex;
            Status = isRestart
                ? $"Caret moved. Continuing with {backend.Name} from character {CaretIndex:N0}."
                : $"Playing with {backend.Name} from character {CaretIndex:N0}.";
        }
        catch (Exception exception)
        {
            StopPlayback($"Playback failed: {exception.Message}");
        }
    }

    private void StopPlayback(string status)
    {
        try
        {
            _speech.Stop();
        }
        catch (Exception exception)
        {
            status = $"Could not stop playback cleanly: {exception.Message}";
        }
        IsPlaying = false;
        PlaybackIndex = -1;
        PlaybackCharacterCount = 0;
        Status = status;
    }

    private void OpenSettings()
    {
        StopPlayback("Playback stopped while settings are open.");
        try
        {
            var result = _interactions.EditSettings(CloneSettings(_settings));
            if (result is null)
                return;
            _settings = CloneSettings(result);
            RefreshBackendStatus();
            Status = "Speech settings saved.";
        }
        catch (Exception exception)
        {
            Status = $"Could not open speech settings: {exception.Message}";
        }
    }

    private BackendDefinition? ActiveBackend() =>
        _settings.Backends.FirstOrDefault(backend => backend.Id == _settings.ActiveBackendId);

    private void RefreshBackendStatus()
    {
        var backend = ActiveBackend();
        BackendStatus = backend is null
            ? "Backend: missing"
            : $"Backend: {backend.Name} ({(_settingsStore.IsAvailable(backend) ? "available" : "unavailable")})";
    }

    private void SpeechPlaybackEnded(object? sender, string status) => RunOnContext(() =>
    {
        IsPlaying = false;
        PlaybackIndex = -1;
        PlaybackCharacterCount = 0;
        Status = status;
    });

    private void SpeechPlaybackProgress(object? sender, SpeechProgressEventArgs args) => RunOnContext(() =>
    {
        var bounded = Math.Clamp(args.CharacterIndex, 0, _renderedText.Length);
        PlaybackCharacterCount = Math.Max(1, args.CharacterCount);
        PlaybackIndex = bounded;
        CaretIndex = bounded;
    });

    private void RunOnContext(Action action)
    {
        if (_synchronizationContext is null || SynchronizationContext.Current == _synchronizationContext)
            action();
        else
            _synchronizationContext.Post(_ => action(), null);
    }

    private void CancelCurrentLoad(bool setStatus)
    {
        if (_loadCancellation is null)
            return;
        _loadCancellation.Cancel();
        if (setStatus)
            Status = "Document loading canceled.";
    }

    private void DetachAndCancelLoad()
    {
        var cancellation = _loadCancellation;
        _loadCancellation = null;
        IsLoading = false;
        cancellation?.Cancel();
    }

    private static bool IsMarkdown(string path) =>
        Path.GetExtension(path).Equals(".md", StringComparison.OrdinalIgnoreCase) ||
        Path.GetExtension(path).Equals(".markdown", StringComparison.OrdinalIgnoreCase);

    private static ReaderSettings CloneSettings(ReaderSettings settings) => new()
    {
        ActiveBackendId = settings.ActiveBackendId,
        Backends = settings.Backends.Select(backend => backend.Clone()).ToList(),
        PlaybackRate = settings.PlaybackRate,
        LastFolderPath = settings.LastFolderPath,
        LastSelectedFilePath = settings.LastSelectedFilePath
    };

    private static double NormalizePlaybackRate(double value) =>
        AvailablePlaybackSpeeds.Any(option => option.Multiplier == value) ? value : 1.0;

    private string? TrySaveSettings()
    {
        try
        {
            _settingsStore.Save(_settings);
            return null;
        }
        catch (Exception exception)
        {
            return exception.Message;
        }
    }

    private static DocumentNode? FindDocument(DocumentNode root, string fullPath)
    {
        if (!root.IsFolder && string.Equals(root.FullPath, fullPath, StringComparison.OrdinalIgnoreCase))
            return root;

        foreach (var child in root.Children)
        {
            var match = FindDocument(child, fullPath);
            if (match is not null)
                return match;
        }

        return null;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _speech.PlaybackEnded -= SpeechPlaybackEnded;
        _speech.PlaybackProgress -= SpeechPlaybackProgress;
        DetachAndCancelLoad();
        _speech.Dispose();
    }
}
