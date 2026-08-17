using Microsoft.Win32;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using TtsReader.Models;
using TtsReader.Services;

namespace TtsReader;

public partial class MainWindow : Window
{
    private readonly DocumentCatalog _catalog = new();
    private readonly DocumentTextExtractor _extractor = new();
    private readonly SettingsStore _settingsStore = new();
    private readonly SpeechPlaybackService _speech = new();
    private ReaderSettings _settings;
    private CancellationTokenSource? _loadCancellation;
    private bool _isPlaying;
    private bool _suppressCaretRestart;

    public MainWindow()
    {
        InitializeComponent();
        _settings = _settingsStore.Load();
        _speech.PlaybackEnded += Speech_PlaybackEnded;
        RefreshBackendLabel();
    }

    private void OpenFolder_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Choose a document folder",
            Multiselect = false
        };
        if (dialog.ShowDialog(this) != true)
            return;

        StopPlayback("Playback stopped.");
        try
        {
            var root = _catalog.Build(dialog.FolderName);
            DocumentTree.ItemsSource = new[] { root };
            _suppressCaretRestart = true;
            DocumentText.Clear();
            _suppressCaretRestart = false;
            StatusText.Text = root.Children.Count == 0
                ? $"No supported .txt, .md, or .pdf files were found in {dialog.FolderName}."
                : $"Browsing {dialog.FolderName}";
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Could not open the folder: {ex.Message}";
        }
    }

    private async void DocumentTree_SelectedItemChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue is not DocumentNode { IsFolder: false, FullPath: not null } file)
            return;

        StopPlayback("Playback stopped.");
        _loadCancellation?.Cancel();
        _loadCancellation?.Dispose();
        _loadCancellation = new CancellationTokenSource();
        StatusText.Text = $"Loading {file.Name}...";

        try
        {
            var text = await _extractor.ReadAsync(file.FullPath, _loadCancellation.Token);
            _suppressCaretRestart = true;
            DocumentText.Text = text;
            DocumentText.CaretIndex = 0;
            DocumentText.ScrollToHome();
            _suppressCaretRestart = false;
            StatusText.Text = string.IsNullOrWhiteSpace(text)
                ? $"{file.Name} is empty."
                : $"Loaded {file.Name} ({text.Length:N0} characters).";
            DocumentText.Focus();
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            _suppressCaretRestart = true;
            DocumentText.Clear();
            _suppressCaretRestart = false;
            StatusText.Text = $"Could not load {file.Name}: {ex.Message}";
        }
    }

    private void Play_Click(object sender, RoutedEventArgs e) => StartFromCaret(isRestart: false);

    private void StartFromCaret(bool isRestart)
    {
        if (string.IsNullOrWhiteSpace(DocumentText.Text))
        {
            StatusText.Text = "Load a non-empty document before starting playback.";
            return;
        }

        var backend = ActiveBackend();
        if (backend is null)
        {
            StatusText.Text = "The active speech backend is missing from settings.";
            return;
        }
        if (!_settingsStore.IsAvailable(backend))
        {
            StatusText.Text = $"'{backend.Name}' is unavailable. Open Settings to download it or select another backend.";
            return;
        }

        try
        {
            _speech.Speak(DocumentText.Text, DocumentText.CaretIndex, backend);
            _isPlaying = true;
            PlayButton.IsEnabled = false;
            StopButton.IsEnabled = true;
            StatusText.Text = isRestart
                ? $"Caret moved. Continuing with {backend.Name} from character {DocumentText.CaretIndex:N0}."
                : $"Playing with {backend.Name} from character {DocumentText.CaretIndex:N0}.";
        }
        catch (Exception ex)
        {
            StopPlayback($"Playback failed: {ex.Message}");
        }
    }

    private void DocumentText_SelectionChanged(object sender, RoutedEventArgs e)
    {
        if (_isPlaying && !_suppressCaretRestart)
            StartFromCaret(isRestart: true);
    }

    private void Stop_Click(object sender, RoutedEventArgs e) => StopPlayback("Playback stopped.");

    private void StopPlayback(string status)
    {
        _speech.Stop();
        _isPlaying = false;
        PlayButton.IsEnabled = true;
        StopButton.IsEnabled = false;
        StatusText.Text = status;
    }

    private void Settings_Click(object sender, RoutedEventArgs e)
    {
        StopPlayback("Playback stopped while settings are open.");
        var window = new SettingsWindow(_settingsStore, _settings) { Owner = this };
        if (window.ShowDialog() == true)
        {
            _settings = window.ResultSettings;
            RefreshBackendLabel();
            StatusText.Text = "Speech settings saved.";
        }
    }

    private BackendDefinition? ActiveBackend() =>
        _settings.Backends.FirstOrDefault(b => b.Id == _settings.ActiveBackendId);

    private void RefreshBackendLabel()
    {
        var backend = ActiveBackend();
        BackendLabel.Text = backend is null
            ? "Backend: missing"
            : $"Backend: {backend.Name} ({(_settingsStore.IsAvailable(backend) ? "available" : "unavailable")})";
    }

    private void Speech_PlaybackEnded(object? sender, string status)
    {
        Dispatcher.BeginInvoke(() =>
        {
            _isPlaying = false;
            PlayButton.IsEnabled = true;
            StopButton.IsEnabled = false;
            StatusText.Text = status;
        }, DispatcherPriority.Background);
    }

    protected override void OnClosed(EventArgs e)
    {
        _loadCancellation?.Cancel();
        _loadCancellation?.Dispose();
        _speech.Dispose();
        base.OnClosed(e);
    }
}
