using TtsReader.Models;

namespace TtsReader.ViewModels;

public sealed class BackendRowViewModel : ViewModel
{
    private bool _isActive;
    private bool _isAvailable;
    private bool _isDownloading;
    private double _downloadProgress;
    private string _downloadStatus = string.Empty;

    public BackendDefinition Backend { get; }
    public string Id => Backend.Id;
    public string Name => Backend.Name;
    public string Kind => Backend.Kind;
    public string Engine => Backend.Engine;
    public bool IsBuiltIn => Backend.BuiltIn;
    public string Availability => IsAvailable ? "Available locally" : "Unavailable";
    public string DisplayName => IsActive ? $"✓ {Name} (active)" : Name;
    public bool ShowDownload => !IsAvailable && SpeechEngines.IsLlmEngine(Engine);
    public bool IsDownloading
    {
        get => _isDownloading;
        set => SetProperty(ref _isDownloading, value);
    }

    public double DownloadProgress
    {
        get => _downloadProgress;
        set => SetProperty(ref _downloadProgress, value);
    }

    public string DownloadStatus
    {
        get => _downloadStatus;
        set => SetProperty(ref _downloadStatus, value);
    }

    public string ExecutablePath
    {
        get => Backend.ExecutablePath ?? string.Empty;
        set
        {
            var normalized = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            if (Backend.ExecutablePath == normalized) return;
            Backend.ExecutablePath = normalized;
            OnPropertyChanged();
        }
    }

    public string ModelPath
    {
        get => Backend.ModelPath ?? string.Empty;
        set
        {
            var normalized = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            if (Backend.ModelPath == normalized) return;
            Backend.ModelPath = normalized;
            OnPropertyChanged();
        }
    }

    public string Voice
    {
        get => Backend.VoiceName ?? string.Empty;
        set
        {
            var normalized = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            if (Backend.VoiceName == normalized) return;
            Backend.VoiceName = normalized;
            OnPropertyChanged();
        }
    }

    public string Variant
    {
        get => Backend.Variant ?? string.Empty;
        set
        {
            var normalized = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            if (Backend.Variant == normalized) return;
            Backend.Variant = normalized;
            OnPropertyChanged();
        }
    }

    public string Language
    {
        get => Backend.Language ?? string.Empty;
        set
        {
            var normalized = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            if (Backend.Language == normalized) return;
            Backend.Language = normalized;
            OnPropertyChanged();
        }
    }

    public string Instruct
    {
        get => Backend.Instruct ?? string.Empty;
        set
        {
            var normalized = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            if (Backend.Instruct == normalized) return;
            Backend.Instruct = normalized;
            OnPropertyChanged();
        }
    }

    public bool IsActive
    {
        get => _isActive;
        set
        {
            if (!SetProperty(ref _isActive, value)) return;
            OnPropertyChanged(nameof(DisplayName));
        }
    }

    public bool IsAvailable
    {
        get => _isAvailable;
        set
        {
            if (!SetProperty(ref _isAvailable, value)) return;
            OnPropertyChanged(nameof(Availability));
            OnPropertyChanged(nameof(ShowDownload));
        }
    }

    public BackendRowViewModel(BackendDefinition backend, bool isActive, bool isAvailable)
    {
        Backend = backend;
        _isActive = isActive;
        _isAvailable = isAvailable;
    }

    public void RefreshConfiguration()
    {
        OnPropertyChanged(nameof(ExecutablePath));
        OnPropertyChanged(nameof(ModelPath));
        OnPropertyChanged(nameof(Voice));
    }
}
