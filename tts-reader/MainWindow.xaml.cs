using Microsoft.Win32;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
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
    private Point _textMouseDownPoint;
    private bool _textClickCandidate;
    private int _documentTextLength;
    private int _documentSymbolCount;

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
        _ = ViewModel.RestoreLastSessionAsync();
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

    private void DocumentText_PreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        _textMouseDownPoint = e.GetPosition(DocumentText);
        _textClickCandidate = true;
    }

    private void DocumentText_PreviewMouseMove(object sender, MouseEventArgs e)
    {
        if (!_textClickCandidate || e.LeftButton != MouseButtonState.Pressed)
            return;

        var point = e.GetPosition(DocumentText);
        if (Math.Abs(point.X - _textMouseDownPoint.X) >= SystemParameters.MinimumHorizontalDragDistance ||
            Math.Abs(point.Y - _textMouseDownPoint.Y) >= SystemParameters.MinimumVerticalDragDistance)
            _textClickCandidate = false;
    }

    private void DocumentText_PreviewMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (!_textClickCandidate)
            return;

        _textClickCandidate = false;
        Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(() =>
        {
            if (!_suppressCaretRestart && !ViewModel.IsPlaying)
                ViewModel.PlayCommand.Execute(null);
        }));
    }

    private void ViewModel_PropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainWindowViewModel.RenderedDocument))
            ApplyRenderedDocument(ViewModel.RenderedDocument);
        else if (e.PropertyName == nameof(MainWindowViewModel.SelectedDocument))
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(SelectRestoredDocument));
        else if (e.PropertyName == nameof(MainWindowViewModel.PlaybackIndex))
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
            var documentText = GetDocumentText();
            _documentTextLength = documentText.Length;
            _documentSymbolCount = DocumentText.Document.ContentStart.GetOffsetToPosition(
                DocumentText.Document.ContentEnd);
            ViewModel.SetRenderedText(documentText);
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
        var scrollViewer = FindScrollViewer(DocumentText);
        var horizontalOffset = scrollViewer?.HorizontalOffset;
        var verticalOffset = scrollViewer?.VerticalOffset;
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

            // Moving the caret/selection can make WPF bring the current speech
            // position into view. Restore the user's viewport after updating
            // the marker so playback never hijacks scrolling.
            if (scrollViewer is not null && horizontalOffset is not null && verticalOffset is not null)
            {
                scrollViewer.ScrollToHorizontalOffset(horizontalOffset.Value);
                scrollViewer.ScrollToVerticalOffset(verticalOffset.Value);
            }
        }
        finally
        {
            _suppressCaretRestart = false;
        }
    }

    private TextPointer GetTextPointerAtOffset(int offset)
    {
        var contentStart = DocumentText.Document.ContentStart;
        var contentEnd = DocumentText.Document.ContentEnd;
        var bounded = Math.Clamp(offset, 0, _documentTextLength);

        // TextPointer offsets use WPF's symbol space, which includes element
        // boundaries for paragraphs, runs, tables, etc. The caret and speech
        // progress use TextRange text offsets, so map through the actual text
        // produced by each candidate position instead of treating the two
        // offset spaces as interchangeable.
        var symbolCount = _documentSymbolCount > 0
            ? _documentSymbolCount
            : contentStart.GetOffsetToPosition(contentEnd);
        var low = 0;
        var high = symbolCount;
        while (low < high)
        {
            var middle = low + (high - low) / 2;
            var candidate = contentStart.GetPositionAtOffset(middle, LogicalDirection.Forward)
                ?? contentEnd;
            var textOffset = new TextRange(contentStart, candidate).Text.Length;
            if (textOffset < bounded)
                low = middle + 1;
            else
                high = middle;
        }

        return contentStart.GetPositionAtOffset(low, LogicalDirection.Forward) ?? contentEnd;
    }

    private static ScrollViewer? FindScrollViewer(DependencyObject root)
    {
        for (var index = 0; index < VisualTreeHelper.GetChildrenCount(root); index++)
        {
            var child = VisualTreeHelper.GetChild(root, index);
            if (child is ScrollViewer scrollViewer)
                return scrollViewer;

            var descendant = FindScrollViewer(child);
            if (descendant is not null)
                return descendant;
        }

        return null;
    }

    private int _restoreAttempts;
    private DocumentNode? _restoreTarget;

    private const int MaxRestoreAttempts = 100;

    private void SelectRestoredDocument()
    {
        var target = ViewModel.SelectedDocument;
        if (target is null)
            return;

        if (!ReferenceEquals(_restoreTarget, target))
        {
            _restoreTarget = target;
            _restoreAttempts = 0;
        }

        if (++_restoreAttempts > MaxRestoreAttempts)
            return;

        DocumentTree.UpdateLayout();
        if (SelectTreeItem(DocumentTree, target))
        {
            _restoreTarget = null;
            _restoreAttempts = 0;
            return;
        }

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
