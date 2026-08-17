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
        }
    }

    public string Status { get => _status; private set => SetProperty(ref _status, value); }
    public RelayCommand ActivateCommand { get; }
    public RelayCommand SaveCommand { get; }
    public RelayCommand CancelCommand { get; }

    public SettingsWindowViewModel(ISettingsStore store, ReaderSettings settings)
    {
        _store = store;
        _editingSettings = CloneSettings(settings);
        _activeId = _editingSettings.ActiveBackendId;
        Backends = new ObservableCollection<BackendRowViewModel>(_editingSettings.Backends.Select(backend =>
            new BackendRowViewModel(backend, backend.Id == _activeId, store.IsAvailable(backend))));

        ActivateCommand = new RelayCommand(_ => ActivateSelected(), _ => SelectedBackend is not null);
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

    public void Save()
    {
        _editingSettings.ActiveBackendId = _activeId;
        try
        {
            _store.Save(_editingSettings);
            ResultSettings = CloneSettings(_editingSettings);
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
        Status = SelectedBackend.IsAvailable
            ? $"{SelectedBackend.Name} is available locally."
            : $"{SelectedBackend.Name} is unavailable. Configure the Piper executable, ONNX model, and adjacent .json file.";
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

    private static ReaderSettings CloneSettings(ReaderSettings settings) => new()
    {
        ActiveBackendId = settings.ActiveBackendId,
        Backends = settings.Backends.Select(backend => backend.Clone()).ToList(),
        PlaybackRate = settings.PlaybackRate,
        LastFolderPath = settings.LastFolderPath,
        LastSelectedFilePath = settings.LastSelectedFilePath
    };

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
    }
}
