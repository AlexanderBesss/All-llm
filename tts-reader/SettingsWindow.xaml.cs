using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Controls;
using TtsReader.Models;
using TtsReader.Services;

namespace TtsReader;

public partial class SettingsWindow : Window
{
    private readonly SettingsStore _store;
    private readonly BackendDownloader _downloader = new();
    private readonly ObservableCollection<BackendRow> _rows;
    private string _activeId;
    private bool _updatingSelection;
    private BackendRow? _editingRow;

    public ReaderSettings ResultSettings { get; private set; }

    public SettingsWindow(SettingsStore store, ReaderSettings settings)
    {
        InitializeComponent();
        _store = store;
        ResultSettings = new ReaderSettings
        {
            ActiveBackendId = settings.ActiveBackendId,
            Backends = settings.Backends.Select(b => b.Clone()).ToList()
        };
        _activeId = ResultSettings.ActiveBackendId;
        _rows = new ObservableCollection<BackendRow>(ResultSettings.Backends.Select(CreateRow));
        BackendList.ItemsSource = _rows;
        BackendList.SelectedItem = _rows.FirstOrDefault(r => r.Backend.Id == _activeId) ?? _rows.FirstOrDefault();
        SettingsStatus.Text = "Select a backend to inspect its local availability.";
    }

    private BackendRow CreateRow(BackendDefinition backend) =>
        new(backend, backend.Id == _activeId, _store.IsAvailable(backend));

    private void BackendList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        SaveEditorValues();
        if (BackendList.SelectedItem is not BackendRow row)
            return;
        _editingRow = row;
        _updatingSelection = true;
        SourceText.Text = row.Backend.DownloadSource ?? string.Empty;
        VoiceText.Text = row.Backend.VoiceName ?? string.Empty;
        _updatingSelection = false;
        DownloadButton.IsEnabled = !row.Backend.BuiltIn && !row.IsAvailable;
        SettingsStatus.Text = row.IsAvailable
            ? $"{row.Backend.Name} is available locally."
            : $"{row.Backend.Name} is unavailable. Configure a source and choose Download.";
    }

    private void SaveEditorValues()
    {
        if (_updatingSelection || _editingRow is not { } row)
            return;
        row.Backend.DownloadSource = string.IsNullOrWhiteSpace(SourceText.Text) ? null : SourceText.Text.Trim();
        row.Backend.VoiceName = string.IsNullOrWhiteSpace(VoiceText.Text) ? null : VoiceText.Text.Trim();
    }

    private void Activate_Click(object sender, RoutedEventArgs e)
    {
        if (BackendList.SelectedItem is not BackendRow selected)
            return;
        _activeId = selected.Backend.Id;
        foreach (var row in _rows)
            row.IsActive = row.Backend.Id == _activeId;
        SettingsStatus.Text = $"{selected.Backend.Name} is now the active selection. Save to persist it.";
    }

    private async void Download_Click(object sender, RoutedEventArgs e)
    {
        SaveEditorValues();
        if (BackendList.SelectedItem is not BackendRow row)
            return;

        DownloadButton.IsEnabled = false;
        ActivateButton.IsEnabled = false;
        DownloadProgress.Value = 0;
        SettingsStatus.Text = $"Downloading {row.Backend.Name}...";
        try
        {
            var progress = new Progress<int>(value =>
            {
                DownloadProgress.Value = value;
                SettingsStatus.Text = $"Downloading {row.Backend.Name}: {value}%";
            });
            await _downloader.DownloadAsync(row.Backend, _store.GetPackagePath(row.Backend), progress);
            row.IsAvailable = true;
            SettingsStatus.Text = $"{row.Backend.Name} downloaded successfully and is ready to use.";
        }
        catch (Exception ex)
        {
            row.IsAvailable = false;
            SettingsStatus.Text = $"Download failed: {ex.Message}";
            DownloadButton.IsEnabled = true;
        }
        finally
        {
            ActivateButton.IsEnabled = true;
        }
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        SaveEditorValues();
        ResultSettings.ActiveBackendId = _activeId;
        try
        {
            _store.Save(ResultSettings);
            DialogResult = true;
        }
        catch (Exception ex)
        {
            SettingsStatus.Text = $"Could not save settings: {ex.Message}";
        }
    }

    private sealed class BackendRow : INotifyPropertyChanged
    {
        private bool _isActive;
        private bool _isAvailable;
        public BackendDefinition Backend { get; }
        public string Availability => IsAvailable ? "Available locally" : "Unavailable";
        public string DisplayName => IsActive ? $"✓ {Backend.Name} (active)" : Backend.Name;

        public bool IsActive
        {
            get => _isActive;
            set { _isActive = value; Notify(); Notify(nameof(DisplayName)); }
        }

        public bool IsAvailable
        {
            get => _isAvailable;
            set { _isAvailable = value; Notify(); Notify(nameof(Availability)); }
        }

        public BackendRow(BackendDefinition backend, bool isActive, bool isAvailable)
        {
            Backend = backend;
            _isActive = isActive;
            _isAvailable = isAvailable;
        }

        public event PropertyChangedEventHandler? PropertyChanged;
        private void Notify([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }
}
