using System.Windows;
using TtsReader.Models;
using TtsReader.Services;
using TtsReader.ViewModels;

namespace TtsReader;

public partial class SettingsWindow : Window
{
    public SettingsWindowViewModel ViewModel { get; }
    public ReaderSettings? ResultSettings => ViewModel.ResultSettings;

    public SettingsWindow(ISettingsStore store, ReaderSettings settings)
    {
        InitializeComponent();
        ViewModel = new SettingsWindowViewModel(store, settings);
        DataContext = ViewModel;
        ViewModel.CloseRequested += ViewModel_CloseRequested;
    }

    private void ViewModel_CloseRequested(object? sender, bool? result) => DialogResult = result;

    protected override void OnClosed(EventArgs e)
    {
        ViewModel.CloseRequested -= ViewModel_CloseRequested;
        ViewModel.Dispose();
        base.OnClosed(e);
    }
}
