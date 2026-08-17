using Microsoft.Win32;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Threading;
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
        ViewModel.RestoreLastSession();
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
        else if (e.PropertyName == nameof(MainWindowViewModel.SelectedDocument))
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(SelectRestoredDocument));
        else if (e.PropertyName == nameof(MainWindowViewModel.PlaybackIndex) ||
                 e.PropertyName == nameof(MainWindowViewModel.PlaybackCharacterCount))
            ApplyPlaybackMarker();
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

    private void ApplyPlaybackMarker()
    {
        _suppressCaretRestart = true;
        try
        {
            var index = ViewModel.PlaybackIndex >= 0
                ? ViewModel.PlaybackIndex
                : ViewModel.CaretIndex;
            var start = GetTextPointerAtOffset(index);
            DocumentText.CaretPosition = start;

            if (ViewModel.PlaybackIndex >= 0)
            {
                var end = GetTextPointerAtOffset(index + Math.Max(1, ViewModel.PlaybackCharacterCount));
                DocumentText.Selection.Select(start, end);
            }
            else
            {
                DocumentText.Selection.Select(start, start);
            }

            if (ViewModel.PlaybackIndex >= 0)
                DocumentText.Focus();
        }
        finally
        {
            _suppressCaretRestart = false;
        }
    }

    private TextPointer GetTextPointerAtOffset(int offset)
    {
        var bounded = Math.Clamp(offset, 0, GetDocumentText().Length);
        return DocumentText.Document.ContentStart.GetPositionAtOffset(
                   bounded, LogicalDirection.Forward) ?? DocumentText.Document.ContentEnd;
    }

    private void SelectRestoredDocument()
    {
        if (ViewModel.SelectedDocument is null)
            return;

        DocumentTree.UpdateLayout();
        if (SelectTreeItem(DocumentTree, ViewModel.SelectedDocument))
            return;

        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(SelectRestoredDocument));
    }

    private static bool SelectTreeItem(ItemsControl parent, DocumentNode target)
    {
        foreach (var item in parent.Items)
        {
            if (parent.ItemContainerGenerator.ContainerFromItem(item) is not TreeViewItem container)
                continue;

            if (ReferenceEquals(item, target))
            {
                container.IsSelected = true;
                container.BringIntoView();
                return true;
            }

            if (item is DocumentNode { IsFolder: true })
            {
                container.IsExpanded = true;
                container.UpdateLayout();
                if (SelectTreeItem(container, target))
                    return true;
            }
        }

        return false;
    }

    protected override void OnClosed(EventArgs e)
    {
        ViewModel.PropertyChanged -= ViewModel_PropertyChanged;
        ViewModel.Dispose();
        base.OnClosed(e);
    }
}
