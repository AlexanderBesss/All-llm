using System.Collections.ObjectModel;
using TtsReader.Models;
using TtsReader.Services;

namespace TtsReader.ViewModels;

public sealed class SettingsWindowViewModel : ViewModel, IDisposable
{
    private readonly ISettingsStore _store;
    private readonly ReaderSettings _editingSettings;
    private BackendRowViewModel? _selectedBackend;
    private string _activeId;
    private string _status = "Select a backend to inspect its local availability.";
    private readonly ILlmBackendDownloader _downloader;
    private CancellationTokenSource? _downloadCancellation;
    private bool _isDownloading;
    private bool _disposed;

    public ObservableCollection<BackendRowViewModel> Backends { get; }
    public ReaderSettings? ResultSettings { get; private set; }
    public event EventHandler<bool?>? CloseRequested;

    public BackendRowViewModel? SelectedBackend
    {
        get => _selectedBackend;
        set
        {
            if (!SetProperty(ref _selectedBackend, value)) return;
            OnPropertyChanged(nameof(SelectedExecutablePath));
            OnPropertyChanged(nameof(SelectedModelPath));
            OnPropertyChanged(nameof(SelectedVoice));
            OnPropertyChanged(nameof(SelectedVariant));
            OnPropertyChanged(nameof(SelectedLanguage));
            OnPropertyChanged(nameof(SelectedInstruct));
            OnPropertyChanged(nameof(EngineLabel));
            OnPropertyChanged(nameof(ExecutableLabel));
            OnPropertyChanged(nameof(ModelLabel));
            OnPropertyChanged(nameof(VoiceLabel));
            OnPropertyChanged(nameof(ShowExecutable));
            OnPropertyChanged(nameof(ShowModel));
            OnPropertyChanged(nameof(ShowVoice));
            OnPropertyChanged(nameof(ShowVariant));
            OnPropertyChanged(nameof(ShowLanguage));
            OnPropertyChanged(nameof(ShowInstruct));
            RefreshSelectedStatus();
            RaiseCommandStates();
        }
    }

    public string SelectedExecutablePath
    {
        get => SelectedBackend?.ExecutablePath ?? string.Empty;
        set
        {
            if (SelectedBackend is null) return;
            SelectedBackend.ExecutablePath = value;
            OnPropertyChanged();
            RefreshSelectedAvailability();
        }
    }

    public string SelectedModelPath
    {
        get => SelectedBackend?.ModelPath ?? string.Empty;
        set
        {
            if (SelectedBackend is null) return;
            SelectedBackend.ModelPath = value;
            OnPropertyChanged();
            RefreshSelectedAvailability();
        }
    }

    public string SelectedVoice
    {
        get => SelectedBackend?.Voice ?? string.Empty;
        set
        {
            if (SelectedBackend is null) return;
            SelectedBackend.Voice = value;
            OnPropertyChanged();
            RefreshSelectedAvailability();
        }
    }

    public string SelectedVariant
    {
        get => SelectedBackend?.Variant ?? string.Empty;
        set
        {
            if (SelectedBackend is null) return;
            SelectedBackend.Variant = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(VoiceLabel));
            RefreshSelectedAvailability();
        }
    }

    public string SelectedLanguage
    {
        get => SelectedBackend?.Language ?? string.Empty;
        set
        {
            if (SelectedBackend is null) return;
            SelectedBackend.Language = value;
            OnPropertyChanged();
        }
    }

    public string SelectedInstruct
    {
        get => SelectedBackend?.Instruct ?? string.Empty;
        set
        {
            if (SelectedBackend is null) return;
            SelectedBackend.Instruct = value;
            OnPropertyChanged();
            RefreshSelectedAvailability();
        }
    }

    public string EngineLabel => SpeechEngines.DisplayName(SelectedBackend?.Engine);
    public string ExecutableLabel => SpeechEngines.IsLlmEngine(SelectedBackend?.Engine)
        ? "Python executable (venv python.exe)"
        : "Piper executable (piper.exe)";
    public string ModelLabel => SpeechEngines.IsLlmEngine(SelectedBackend?.Engine)
        ? "Model (Hugging Face repo or local path)"
        : "Piper ONNX model (.onnx)";
    public string VoiceLabel => SelectedBackend?.Engine switch
    {
        SpeechEngines.Windows => "Windows voice name",
        SpeechEngines.Chatterbox => SelectedBackend is not null && SpeechEngines.IsChatterboxReferenceRequired(SelectedBackend.Backend)
            ? "Reference voice clip (.wav, required)"
            : "Reference voice clip (.wav, optional)",
        SpeechEngines.Qwen3Tts when SelectedBackend is not null && SpeechEngines.IsQwenVoiceClone(SelectedBackend.Backend)
            => "Reference voice clip (.wav, required)",
        SpeechEngines.Qwen3Tts when SelectedBackend is not null && SpeechEngines.IsQwenVoiceDesign(SelectedBackend.Backend)
            => "Voice description",
        SpeechEngines.Qwen3Tts => "Speaker name",
        _ => "Speaker / voice description / reference .wav path"
    };
    public bool ShowExecutable => SpeechEngines.IsLocalProcessEngine(SelectedBackend?.Engine);
    public bool ShowModel => SpeechEngines.IsLocalProcessEngine(SelectedBackend?.Engine);
    public bool ShowVoice => SelectedBackend is not null && SelectedBackend.Engine != SpeechEngines.Piper;
    public bool ShowVariant => SpeechEngines.IsLlmEngine(SelectedBackend?.Engine);
    public bool ShowLanguage => SpeechEngines.IsLlmEngine(SelectedBackend?.Engine);
    public bool ShowInstruct => SpeechEngines.IsLlmEngine(SelectedBackend?.Engine);

    public string Status { get => _status; private set => SetProperty(ref _status, value); }
    public RelayCommand ActivateCommand { get; }
    public AsyncRelayCommand DownloadCommand { get; }
    public RelayCommand SaveCommand { get; }
    public RelayCommand CancelCommand { get; }

    public SettingsWindowViewModel(
        ISettingsStore store,
        ReaderSettings settings,
        ILlmBackendDownloader? downloader = null)
    {
        _store = store;
        _downloader = downloader ?? new LlmBackendDownloader();
        _editingSettings = settings.Clone();
        _activeId = _editingSettings.ActiveBackendId;
        Backends = new ObservableCollection<BackendRowViewModel>(_editingSettings.Backends.Select(backend =>
            new BackendRowViewModel(backend, backend.Id == _activeId, store.IsAvailable(backend))));

        ActivateCommand = new RelayCommand(_ => ActivateSelected(), _ => SelectedBackend is not null);
        DownloadCommand = new AsyncRelayCommand(DownloadBackendAsync, CanDownloadBackend);
        SaveCommand = new RelayCommand(_ => Save());
        CancelCommand = new RelayCommand(_ => Cancel());
        SelectedBackend = Backends.FirstOrDefault(row => row.Id == _activeId) ?? Backends.FirstOrDefault();
    }

    public void ActivateSelected()
    {
        if (SelectedBackend is null)
            return;
        _activeId = SelectedBackend.Id;
        foreach (var row in Backends)
            row.IsActive = row.Id == _activeId;
        Status = $"{SelectedBackend.Name} is now the active selection. Save to persist it.";
    }

    private bool CanDownloadBackend(object? parameter) =>
        !_isDownloading && parameter is BackendRowViewModel row && row.ShowDownload;

    private async Task DownloadBackendAsync(object? parameter)
    {
        if (parameter is not BackendRowViewModel row || !row.ShowDownload)
            return;

        _isDownloading = true;
        DownloadCommand.RaiseCanExecuteChanged();
        using var cancellation = new CancellationTokenSource();
        _downloadCancellation = cancellation;
        row.IsDownloading = true;
        row.DownloadProgress = 0;
        row.DownloadStatus = "Starting download…";
        Status = $"Downloading {row.Name}…";

        var progressGate = new object();
        var progressActive = true;
        var progress = new Progress<LlmDownloadProgress>(update =>
        {
            lock (progressGate)
            {
                if (!progressActive)
                    return;
                row.DownloadProgress = update.Percent;
                row.DownloadStatus = update.Status;
                Status = $"{row.Name}: {update.Status}";
            }
        });

        try
        {
            await _downloader.DownloadAsync(row.Backend, progress, cancellation.Token);
            lock (progressGate)
            {
                progressActive = false;
                row.RefreshConfiguration();
                row.IsAvailable = _store.IsAvailable(row.Backend);
                row.DownloadProgress = 100;
                row.DownloadStatus = row.IsAvailable ? "Ready" : "Downloaded; configure settings.";
                Status = row.IsAvailable
                    ? $"{row.Name} is ready to use."
                    : $"{row.Name} downloaded. Configure its voice settings before using it.";
            }
        }
        catch (OperationCanceledException)
        {
            lock (progressGate)
            {
                progressActive = false;
                row.DownloadStatus = "Download canceled.";
                Status = $"Download canceled for {row.Name}.";
            }
        }
        catch (Exception exception)
        {
            lock (progressGate)
            {
                progressActive = false;
                row.DownloadStatus = "Download failed.";
                Status = $"Could not download {row.Name}: {exception.Message}";
            }
        }
        finally
        {
            row.IsDownloading = false;
            _downloadCancellation = null;
            _isDownloading = false;
            DownloadCommand.RaiseCanExecuteChanged();
        }
    }

    public void Save()
    {
        _editingSettings.ActiveBackendId = _activeId;
        try
        {
            _store.Save(_editingSettings);
            ResultSettings = _editingSettings.Clone();
            CloseRequested?.Invoke(this, true);
        }
        catch (Exception exception)
        {
            Status = $"Could not save settings: {exception.Message}";
        }
    }

    public void Cancel()
    {
        ResultSettings = null;
        CloseRequested?.Invoke(this, false);
    }

    private void RefreshSelectedStatus()
    {
        if (SelectedBackend is null)
        {
            Status = "No speech backend is configured.";
            return;
        }
        if (SelectedBackend.IsAvailable)
        {
            Status = $"{SelectedBackend.Name} is available locally.";
            return;
        }
        Status = SelectedBackend.Engine switch
        {
            SpeechEngines.Windows => $"{SelectedBackend.Name} is unavailable. Check the Windows voice name and the local SAPI voices.",
            SpeechEngines.Piper => $"{SelectedBackend.Name} is unavailable. Configure the Piper executable, ONNX model, and adjacent .onnx.json file.",
            SpeechEngines.Chatterbox => $"{SelectedBackend.Name} is unavailable. Create the Python virtual environment, install chatterbox-tts, and set the model (Hugging Face repo id or local path).",
            SpeechEngines.Qwen3Tts when SpeechEngines.IsQwenVoiceClone(SelectedBackend.Backend) => $"{SelectedBackend.Name} is unavailable. Configure the Python environment, model, reference .wav, and transcript.",
            _ => $"{SelectedBackend.Name} is unavailable. Create the Python virtual environment, install qwen-tts, set the model, and provide a speaker, voice description, or reference clip."
        };
    }

    private void RefreshSelectedAvailability()
    {
        if (SelectedBackend is null) return;
        SelectedBackend.IsAvailable = _store.IsAvailable(SelectedBackend.Backend);
        RefreshSelectedStatus();
    }

    private void RaiseCommandStates()
    {
        ActivateCommand?.RaiseCanExecuteChanged();
        SaveCommand?.RaiseCanExecuteChanged();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _downloadCancellation?.Cancel();
    }
}
