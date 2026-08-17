using System.Collections.ObjectModel;
using TtsReader.Models;
using TtsReader.Services;

namespace TtsReader.ViewModels;

public sealed class SettingsWindowViewModel : ViewModel, IDisposable
{
    private readonly ISettingsStore _store;
    private readonly IBackendDownloader _downloader;
    private readonly ReaderSettings _editingSettings;
    private BackendRowViewModel? _selectedBackend;
    private string _activeId;
    private string _status = "Select a backend to inspect its local availability.";
    private int _downloadProgress;
    private bool _isBusy;
    private CancellationTokenSource? _downloadCancellation;
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
            OnPropertyChanged(nameof(SelectedSource));
            OnPropertyChanged(nameof(SelectedVoice));
            RefreshSelectedStatus();
            RaiseCommandStates();
        }
    }

    public string SelectedSource
    {
        get => SelectedBackend?.Source ?? string.Empty;
        set
        {
            if (SelectedBackend is null) return;
            SelectedBackend.Source = value;
            OnPropertyChanged();
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
    public int DownloadProgress { get => _downloadProgress; private set => SetProperty(ref _downloadProgress, value); }

    public bool IsBusy
    {
        get => _isBusy;
        private set
        {
            if (!SetProperty(ref _isBusy, value)) return;
            RaiseCommandStates();
        }
    }

    public RelayCommand ActivateCommand { get; }
    public AsyncRelayCommand DownloadCommand { get; }
    public RelayCommand SaveCommand { get; }
    public RelayCommand CancelCommand { get; }

    public SettingsWindowViewModel(ISettingsStore store, IBackendDownloader downloader, ReaderSettings settings)
    {
        _store = store;
        _downloader = downloader;
        _editingSettings = CloneSettings(settings);
        _activeId = _editingSettings.ActiveBackendId;
        Backends = new ObservableCollection<BackendRowViewModel>(_editingSettings.Backends.Select(backend =>
            new BackendRowViewModel(backend, backend.Id == _activeId, store.IsAvailable(backend))));

        ActivateCommand = new RelayCommand(_ => ActivateSelected(), _ => SelectedBackend is not null && !IsBusy);
        DownloadCommand = new AsyncRelayCommand(
            _ => DownloadSelectedAsync(),
            _ => SelectedBackend is { IsBuiltIn: false, IsAvailable: false } && !IsBusy,
            exception => Status = $"Download failed: {exception.Message}");
        SaveCommand = new RelayCommand(_ => Save(), _ => !IsBusy);
        CancelCommand = new RelayCommand(_ => Cancel());
        SelectedBackend = Backends.FirstOrDefault(row => row.Id == _activeId) ?? Backends.FirstOrDefault();
    }

    public void ActivateSelected()
    {
        if (SelectedBackend is null || IsBusy)
            return;
        _activeId = SelectedBackend.Id;
        foreach (var row in Backends)
            row.IsActive = row.Id == _activeId;
        Status = $"{SelectedBackend.Name} is now the active selection. Save to persist it.";
    }

    public async Task DownloadSelectedAsync()
    {
        var row = SelectedBackend;
        if (row is null || row.IsBuiltIn || row.IsAvailable || IsBusy)
            return;

        _downloadCancellation = new CancellationTokenSource();
        IsBusy = true;
        DownloadProgress = 0;
        Status = $"Downloading {row.Name}...";
        try
        {
            var progress = new Progress<int>(value =>
            {
                DownloadProgress = value;
                Status = $"Downloading {row.Name}: {value}%";
            });
            await _downloader.DownloadAsync(row.Backend, _store.GetPackagePath(row.Backend), progress,
                _downloadCancellation.Token);
            row.IsAvailable = true;
            DownloadProgress = 100;
            Status = $"{row.Name} downloaded successfully and is ready to use.";
        }
        catch (OperationCanceledException)
        {
            Status = $"Downloading {row.Name} was canceled.";
        }
        catch (Exception exception)
        {
            row.IsAvailable = false;
            Status = $"Download failed: {exception.Message}";
        }
        finally
        {
            _downloadCancellation.Dispose();
            _downloadCancellation = null;
            IsBusy = false;
        }
    }

    public void Save()
    {
        if (IsBusy)
            return;
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
        if (IsBusy)
        {
            _downloadCancellation?.Cancel();
            Status = "Canceling download...";
            return;
        }
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
            : $"{SelectedBackend.Name} is unavailable. Configure a source and choose Download.";
    }

    private void RaiseCommandStates()
    {
        ActivateCommand?.RaiseCanExecuteChanged();
        DownloadCommand?.RaiseCanExecuteChanged();
        SaveCommand?.RaiseCanExecuteChanged();
    }

    private static ReaderSettings CloneSettings(ReaderSettings settings) => new()
    {
        ActiveBackendId = settings.ActiveBackendId,
        Backends = settings.Backends.Select(backend => backend.Clone()).ToList()
    };

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _downloadCancellation?.Cancel();
    }
}
