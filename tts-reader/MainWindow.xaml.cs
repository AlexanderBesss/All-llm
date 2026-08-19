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
    private TextPointer? _lastMappedTextPointer;
    private int _lastMappedTextOffset;
    private Paragraph? _lastPlaybackParagraph;

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
            _lastMappedTextPointer = DocumentText.Document.ContentStart;
            _lastMappedTextOffset = 0;
            _lastPlaybackParagraph = null;
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
                var paragraph = start.Paragraph;
                if (paragraph is not null && !ReferenceEquals(paragraph, _lastPlaybackParagraph))
                {
                    _lastPlaybackParagraph = paragraph;
                    paragraph.BringIntoView();
                }
            }
            else
            {
                _lastPlaybackParagraph = null;
                DocumentText.Selection.Select(start, start);
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

        // Playback progress is normally monotonic. Walk forward from the last
        // mapped pointer instead of repeatedly measuring a TextRange from the
        // beginning of a large FlowDocument. The latter is quadratic in the
        // document size when called for every speech progress update.
        if (_lastMappedTextPointer is not null && bounded >= _lastMappedTextOffset)
        {
            var pointer = _lastMappedTextPointer;
            var textOffset = _lastMappedTextOffset;
            while (textOffset < bounded && pointer.CompareTo(contentEnd) < 0)
            {
                var next = pointer.GetPositionAtOffset(1, LogicalDirection.Forward) ?? contentEnd;
                if (next.CompareTo(pointer) <= 0)
                    break;

                textOffset += new TextRange(pointer, next).Text.Length;
                pointer = next;
            }

            if (textOffset >= bounded || pointer.CompareTo(contentEnd) >= 0)
            {
                _lastMappedTextPointer = pointer;
                _lastMappedTextOffset = textOffset;
                return pointer;
            }
        }

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

        var mapped = contentStart.GetPositionAtOffset(low, LogicalDirection.Forward) ?? contentEnd;
        _lastMappedTextPointer = mapped;
        _lastMappedTextOffset = new TextRange(contentStart, mapped).Text.Length;
        return mapped;
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
