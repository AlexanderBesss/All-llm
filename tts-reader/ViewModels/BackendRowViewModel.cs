using TtsReader.Models;

namespace TtsReader.ViewModels;

public sealed class BackendRowViewModel : ViewModel
{
    private bool _isActive;
    private bool _isAvailable;

    public BackendDefinition Backend { get; }
    public string Id => Backend.Id;
    public string Name => Backend.Name;
    public string Kind => Backend.Kind;
    public bool IsBuiltIn => Backend.BuiltIn;
    public string Availability => IsAvailable ? "Available locally" : "Unavailable";
    public string DisplayName => IsActive ? $"✓ {Name} (active)" : Name;

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
        }
    }

    public BackendRowViewModel(BackendDefinition backend, bool isActive, bool isAvailable)
    {
        Backend = backend;
        _isActive = isActive;
        _isAvailable = isAvailable;
    }
}
