using Microsoft.Win32;
using System.ComponentModel;
using System.Windows;
using System.Windows.Documents;
using TtsReader.Models;
using TtsReader.Services;
using TtsReader.ViewModels;

namespace TtsReader;

public partial class MainWindow : Window, IMainViewInteractions
{
    private readonly MarkdownDocumentRenderer _markdownRenderer = new();
    private readonly SettingsStore _settingsStore;
    private bool _suppressCaretRestart;

    public MainWindowViewModel ViewModel { get; }

    public MainWindow()
    {
        InitializeComponent();
        _settingsStore = new SettingsStore();
        ViewModel = new MainWindowViewModel(
            new DocumentCatalog(), new DocumentTextExtractor(), _settingsStore,
            new SpeechPlaybackService(), this);
        DataContext = ViewModel;
        ViewModel.PropertyChanged += ViewModel_PropertyChanged;
        ApplyRenderedDocument(ViewModel.RenderedDocument);
    }

    public string? ChooseFolder()
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Choose a document folder",
            Multiselect = false
        };
        return dialog.ShowDialog(this) == true ? dialog.FolderName : null;
    }

    public ReaderSettings? EditSettings(ReaderSettings settings)
    {
        var window = new SettingsWindow(_settingsStore, settings) { Owner = this };
        return window.ShowDialog() == true ? window.ResultSettings : null;
    }

    private void DocumentTree_SelectedItemChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue is DocumentNode node)
            ViewModel.SelectedDocument = node;
    }

    private void DocumentText_SelectionChanged(object sender, RoutedEventArgs e)
    {
        if (!_suppressCaretRestart)
            ViewModel.UpdateCaret(GetCaretIndex());
    }

    private void ViewModel_PropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainWindowViewModel.RenderedDocument))
            ApplyRenderedDocument(ViewModel.RenderedDocument);
    }

    private void ApplyRenderedDocument(RenderedDocument rendered)
    {
        _suppressCaretRestart = true;
        try
        {
            DocumentText.Document = rendered.IsMarkdown
                ? _markdownRenderer.Render(rendered.Text, rendered.SourcePath)
                : _markdownRenderer.RenderPlainText(rendered.Text);
            DocumentText.CaretPosition = DocumentText.Document.ContentStart;
            DocumentText.ScrollToHome();
            ViewModel.SetRenderedText(GetDocumentText());
            if (!string.IsNullOrWhiteSpace(rendered.Text))
                DocumentText.Focus();
        }
        finally
        {
            _suppressCaretRestart = false;
        }
    }

    private string GetDocumentText() => new TextRange(
        DocumentText.Document.ContentStart,
        DocumentText.Document.ContentEnd).Text;

    private int GetCaretIndex() => new TextRange(
        DocumentText.Document.ContentStart,
        DocumentText.CaretPosition).Text.Length;

    protected override void OnClosed(EventArgs e)
    {
        ViewModel.PropertyChanged -= ViewModel_PropertyChanged;
        ViewModel.Dispose();
        base.OnClosed(e);
    }
}
