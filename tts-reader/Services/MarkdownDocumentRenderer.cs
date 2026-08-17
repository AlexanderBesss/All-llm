using Markdig;
using Markdig.Extensions.Tables;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using IOPath = System.IO.Path;
using MarkdownListBlock = Markdig.Syntax.ListBlock;
using MarkdownTable = Markdig.Extensions.Tables.Table;
using WpfList = System.Windows.Documents.List;
using WpfTable = System.Windows.Documents.Table;

namespace TtsReader.Services;

/// <summary>
/// Parses Markdown with Markdig and maps supported nodes to a native FlowDocument.
/// Native document text remains selectable and is the exact source used by TTS.
/// </summary>
public sealed class MarkdownDocumentRenderer
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder()
        .UseAdvancedExtensions()
        .DisableHtml()
        .Build();

    private static readonly Brush HeadingBrush = FrozenBrush(88, 196, 255);
    private static readonly Brush MutedBrush = FrozenBrush(175, 183, 196);
    private static readonly Brush CodeBackground = FrozenBrush(39, 43, 51);
    private static readonly Brush TableBorderBrush = FrozenBrush(78, 86, 101);
    private static readonly Brush TableHeaderBrush = FrozenBrush(49, 56, 68);
    private static readonly Brush DiagramBackground = FrozenBrush(31, 36, 45);
    private static readonly Brush DiagramNodeBrush = FrozenBrush(49, 75, 98);
    private static readonly Brush DiagramLineBrush = FrozenBrush(124, 196, 234);

    public FlowDocument Render(string markdown, string? sourcePath = null)
    {
        ArgumentNullException.ThrowIfNull(markdown);

        var document = CreateDocument();
        var sourceDirectory = TryGetSourceDirectory(sourcePath);
        MarkdownDocument parsed;
        try
        {
            parsed = Markdown.Parse(markdown, Pipeline);
        }
        catch
        {
            // Opening a document is more important than styling it. Markdig is
            // deliberately isolated so even an unexpected parser failure is safe.
            return RenderPlainText(markdown);
        }

        try
        {
            RenderBlocks(parsed, document.Blocks, sourceDirectory);
            return document;
        }
        catch
        {
            return RenderPlainText(markdown);
        }
    }

    public FlowDocument RenderPlainText(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        var document = CreateDocument();
        var normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
        foreach (var line in normalized.Split('\n'))
            document.Blocks.Add(new Paragraph(new Run(line)) { Margin = new Thickness(0, 0, 0, 4) });
        return document;
    }

    private static FlowDocument CreateDocument() => new()
    {
        Background = Brushes.Transparent,
        Foreground = Brushes.White,
        FontFamily = new FontFamily("Segoe UI"),
        FontSize = 16,
        PagePadding = new Thickness(18),
        ColumnWidth = 10000
    };

    private static Brush FrozenBrush(byte red, byte green, byte blue)
    {
        var brush = new SolidColorBrush(Color.FromRgb(red, green, blue));
        brush.Freeze();
        return brush;
    }

    private static string? TryGetSourceDirectory(string? sourcePath)
    {
        if (string.IsNullOrWhiteSpace(sourcePath))
            return null;
        try
        {
            return IOPath.GetDirectoryName(IOPath.GetFullPath(sourcePath));
        }
        catch (Exception) when (sourcePath is not null)
        {
            return null;
        }
    }

    private static void RenderBlocks(ContainerBlock container, BlockCollection blocks, string? sourceDirectory)
    {
        foreach (var block in container)
            RenderBlock(block, blocks, sourceDirectory);
    }

    private static void RenderBlock(Markdig.Syntax.Block block, BlockCollection blocks, string? sourceDirectory)
    {
        switch (block)
        {
            case HeadingBlock heading:
                AddHeading(blocks, heading, sourceDirectory);
                break;
            case ParagraphBlock paragraph:
                blocks.Add(CreateParagraph(paragraph.Inline, sourceDirectory));
                break;
            case QuoteBlock quote:
                AddQuote(blocks, quote, sourceDirectory);
                break;
            case MarkdownListBlock list:
                AddList(blocks, list, sourceDirectory);
                break;
            case FencedCodeBlock fenced:
                AddCodeOrMermaid(blocks, fenced.Lines.ToString(), fenced.Info?.ToString() ?? string.Empty);
                break;
            case CodeBlock code:
                AddCodeBlock(blocks, code.Lines.ToString(), string.Empty);
                break;
            case MarkdownTable table:
                AddTable(blocks, table, sourceDirectory);
                break;
            case ThematicBreakBlock:
                blocks.Add(new Paragraph
                {
                    BorderBrush = MutedBrush,
                    BorderThickness = new Thickness(0, 0, 0, 1),
                    Margin = new Thickness(0, 8, 0, 12),
                    Padding = new Thickness(0, 2, 0, 2)
                });
                break;
            case ContainerBlock nested:
                RenderBlocks(nested, blocks, sourceDirectory);
                break;
            case LeafBlock leaf:
                AddLeafFallback(blocks, leaf);
                break;
        }
    }

    private static void AddHeading(BlockCollection blocks, HeadingBlock heading, string? sourceDirectory)
    {
        var paragraph = CreateParagraph(heading.Inline, sourceDirectory);
        paragraph.Margin = new Thickness(0, heading.Level == 1 ? 14 : 9, 0, heading.Level == 1 ? 10 : 6);
        paragraph.FontSize = Math.Max(16, 30 - heading.Level * 2);
        paragraph.FontWeight = FontWeights.SemiBold;
        paragraph.Foreground = HeadingBrush;
        blocks.Add(paragraph);
    }

    private static Paragraph CreateParagraph(ContainerInline? inline, string? sourceDirectory)
    {
        var paragraph = new Paragraph { Margin = new Thickness(0, 0, 0, 9) };
        AddInlines(paragraph.Inlines, inline, sourceDirectory);
        return paragraph;
    }

    private static void AddQuote(BlockCollection blocks, QuoteBlock quote, string? sourceDirectory)
    {
        var section = new Section
        {
            Margin = new Thickness(18, 2, 0, 8),
            Padding = new Thickness(12, 2, 0, 2),
            BorderBrush = HeadingBrush,
            BorderThickness = new Thickness(2, 0, 0, 0),
            Foreground = MutedBrush
        };
        RenderBlocks(quote, section.Blocks, sourceDirectory);
        blocks.Add(section);
    }

    private static void AddList(BlockCollection blocks, MarkdownListBlock source, string? sourceDirectory)
    {
        var list = new WpfList
        {
            MarkerStyle = source.IsOrdered ? TextMarkerStyle.Decimal : TextMarkerStyle.Disc,
            StartIndex = source.IsOrdered && int.TryParse(source.OrderedStart, out var start) ? start : 1,
            Margin = new Thickness(12, 0, 0, 9),
            Padding = new Thickness(12, 0, 0, 0)
        };

        foreach (var child in source)
        {
            if (child is not ListItemBlock sourceItem)
                continue;
            var item = new ListItem();
            RenderBlocks(sourceItem, item.Blocks, sourceDirectory);
            if (item.Blocks.Count == 0)
                item.Blocks.Add(new Paragraph());
            list.ListItems.Add(item);
        }
        blocks.Add(list);
    }

    private static void AddCodeOrMermaid(BlockCollection blocks, string code, string language)
    {
        var normalizedLanguage = language.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? string.Empty;
        if (normalizedLanguage.Equals("mermaid", StringComparison.OrdinalIgnoreCase))
            AddMermaidDiagram(blocks, code);
        else
            AddCodeBlock(blocks, code, normalizedLanguage);
    }

    private static void AddCodeBlock(BlockCollection blocks, string code, string language)
    {
        var normalized = code.TrimEnd('\r', '\n');
        var paragraph = new Paragraph
        {
            Background = CodeBackground,
            FontFamily = new FontFamily("Consolas"),
            Foreground = Brushes.White,
            Padding = new Thickness(12),
            Margin = new Thickness(0, 2, 0, 10)
        };
        if (!string.IsNullOrWhiteSpace(language))
        {
            paragraph.Inlines.Add(new Run(language) { Foreground = HeadingBrush, FontSize = 12 });
            paragraph.Inlines.Add(new LineBreak());
        }
        paragraph.Inlines.Add(new Run(normalized));
        blocks.Add(paragraph);
    }

    private static void AddTable(BlockCollection blocks, MarkdownTable source, string? sourceDirectory)
    {
        var rows = source.OfType<Markdig.Extensions.Tables.TableRow>().ToList();
        var columnCount = rows.Select(row => row.Count).DefaultIfEmpty(0).Max();
        if (columnCount == 0)
            return;

        var table = new WpfTable
        {
            CellSpacing = 0,
            Margin = new Thickness(0, 2, 0, 12),
            BorderBrush = TableBorderBrush,
            BorderThickness = new Thickness(1)
        };
        for (var index = 0; index < columnCount; index++)
            table.Columns.Add(new TableColumn { Width = new GridLength(1, GridUnitType.Star) });

        var rowGroup = new TableRowGroup();
        foreach (var sourceRow in rows)
        {
            var row = new System.Windows.Documents.TableRow();
            var isHeader = sourceRow.IsHeader;
            foreach (var sourceCell in sourceRow.OfType<Markdig.Extensions.Tables.TableCell>())
            {
                var cell = new System.Windows.Documents.TableCell
                {
                    Padding = new Thickness(8, 5, 8, 5),
                    BorderBrush = TableBorderBrush,
                    BorderThickness = new Thickness(0.5),
                    Background = isHeader ? TableHeaderBrush : Brushes.Transparent
                };
                RenderBlocks(sourceCell, cell.Blocks, sourceDirectory);
                if (isHeader)
                    foreach (var paragraph in cell.Blocks.OfType<Paragraph>())
                        paragraph.FontWeight = FontWeights.Bold;
                row.Cells.Add(cell);
            }
            while (row.Cells.Count < columnCount)
                row.Cells.Add(new System.Windows.Documents.TableCell(new Paragraph()));
            rowGroup.Rows.Add(row);
        }
        table.RowGroups.Add(rowGroup);
        blocks.Add(table);
    }

    private static void AddLeafFallback(BlockCollection blocks, LeafBlock leaf)
    {
        var fallback = leaf.Lines.ToString().TrimEnd('\r', '\n');
        if (!string.IsNullOrWhiteSpace(fallback))
            blocks.Add(new Paragraph(new Run(fallback)) { Margin = new Thickness(0, 0, 0, 9) });
    }

    private static void AddInlines(InlineCollection target, ContainerInline? source, string? sourceDirectory)
    {
        for (var inline = source?.FirstChild; inline is not null; inline = inline.NextSibling)
            AddInline(target, inline, sourceDirectory);
    }

    private static void AddInline(InlineCollection target, Markdig.Syntax.Inlines.Inline inline, string? sourceDirectory)
    {
        switch (inline)
        {
            case LiteralInline literal:
                target.Add(new Run(literal.Content.ToString()));
                break;
            case CodeInline code:
                target.Add(new Run(code.Content)
                {
                    FontFamily = new FontFamily("Consolas"),
                    Background = CodeBackground,
                    Foreground = Brushes.White
                });
                break;
            case EmphasisInline emphasis:
                var span = emphasis.DelimiterChar == '~'
                    ? new Span { TextDecorations = TextDecorations.Strikethrough }
                    : emphasis.DelimiterCount >= 2 ? new Bold() : new Italic();
                AddInlines(span.Inlines, emphasis, sourceDirectory);
                target.Add(span);
                break;
            case LinkInline link when link.IsImage:
                AddImage(target, link, sourceDirectory);
                break;
            case LinkInline link:
                var hyperlink = new Hyperlink { Foreground = HeadingBrush };
                if (Uri.TryCreate(link.Url, UriKind.RelativeOrAbsolute, out var uri))
                    hyperlink.NavigateUri = uri;
                AddInlines(hyperlink.Inlines, link, sourceDirectory);
                target.Add(hyperlink);
                break;
            case LineBreakInline lineBreak:
                target.Add(lineBreak.IsHard ? new LineBreak() : new Run(" "));
                break;
            case AutolinkInline autoLink:
                target.Add(new Run(autoLink.Url) { Foreground = HeadingBrush });
                break;
            case HtmlEntityInline entity:
                target.Add(new Run(entity.Transcoded.ToString()));
                break;
            case ContainerInline container:
                AddInlines(target, container, sourceDirectory);
                break;
        }
    }

    private static void AddImage(InlineCollection target, LinkInline image, string? sourceDirectory)
    {
        var alt = GetInlineText(image);
        if (string.IsNullOrWhiteSpace(alt))
            alt = "image";
        var imagePath = ResolveImagePath(image.Url, sourceDirectory);
        if (imagePath is not null)
        {
            try
            {
                var bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.UriSource = new Uri(imagePath, UriKind.Absolute);
                bitmap.EndInit();
                bitmap.Freeze();
                target.Add(new InlineUIContainer(new Image
                {
                    Source = bitmap,
                    MaxWidth = 720,
                    MaxHeight = 480,
                    Stretch = Stretch.Uniform,
                    ToolTip = alt
                }));
                target.Add(new LineBreak());
            }
            catch
            {
                // The caption below remains the readable fallback.
            }
        }
        target.Add(new Run($"[Image: {alt}]") { Foreground = MutedBrush });
    }

    private static string GetInlineText(ContainerInline container)
    {
        var parts = new List<string>();
        for (var child = container.FirstChild; child is not null; child = child.NextSibling)
        {
            switch (child)
            {
                case LiteralInline literal:
                    parts.Add(literal.Content.ToString());
                    break;
                case CodeInline code:
                    parts.Add(code.Content);
                    break;
                case ContainerInline nested:
                    parts.Add(GetInlineText(nested));
                    break;
            }
        }
        return string.Concat(parts);
    }

    private static string? ResolveImagePath(string? target, string? sourceDirectory)
    {
        if (string.IsNullOrWhiteSpace(target))
            return null;
        try
        {
            if (Uri.TryCreate(target, UriKind.Absolute, out var uri))
                return uri.IsFile && File.Exists(uri.LocalPath) ? uri.LocalPath : null;
            if (string.IsNullOrWhiteSpace(sourceDirectory))
                return null;
            var decoded = Uri.UnescapeDataString(target).Replace('/', IOPath.DirectorySeparatorChar);
            var path = IOPath.GetFullPath(IOPath.Combine(sourceDirectory, decoded));
            return File.Exists(path) ? path : null;
        }
        catch
        {
            return null;
        }
    }

    private static void AddMermaidDiagram(BlockCollection blocks, string source)
    {
        var normalized = source.TrimEnd('\r', '\n');
        var diagram = MermaidDiagram.TryCreate(normalized);
        if (diagram is null)
        {
            AddCodeBlock(blocks, normalized, "mermaid");
            return;
        }

        blocks.Add(new Paragraph(new Run($"Diagram: {diagram.Description}"))
        {
            Foreground = MutedBrush,
            FontStyle = FontStyles.Italic,
            Margin = new Thickness(0, 2, 0, 4)
        });
        blocks.Add(new BlockUIContainer(diagram.CreateVisual()));
    }

    private sealed class MermaidDiagram
    {
        private static readonly System.Text.RegularExpressions.Regex EdgePattern = new(
            @"^(?<left>[A-Za-z0-9_]+(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}))?)\s*(?:-->|-.->|==>|---?)\s*(?:\|(?<label>[^|]+)\|\s*)?(?<right>[A-Za-z0-9_]+(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}))?)",
            System.Text.RegularExpressions.RegexOptions.Compiled);
        private static readonly System.Text.RegularExpressions.Regex NodePattern = new(
            @"^(?<id>[A-Za-z0-9_]+)\s*(?<shape>\[\[[^\]]*\]\]|\[\([^]]*\)\]|\[\{[^}]*\}\]|\(\([^)]*\)\)|\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?",
            System.Text.RegularExpressions.RegexOptions.Compiled);

        private readonly List<Node> _nodes;
        private readonly List<Edge> _edges;
        private readonly bool _horizontal;

        private MermaidDiagram(List<Node> nodes, List<Edge> edges, bool horizontal)
        {
            _nodes = nodes;
            _edges = edges;
            _horizontal = horizontal;
        }

        public string Description => string.Join(", ", _nodes.Select(node => node.Label));

        public static MermaidDiagram? TryCreate(string source)
        {
            var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n')
                .Select(line => line.Trim().TrimEnd(';'))
                .Where(line => line.Length > 0 && !line.StartsWith("%%", StringComparison.Ordinal))
                .ToList();
            if (lines.Count == 0 ||
                !lines[0].StartsWith("graph ", StringComparison.OrdinalIgnoreCase) &&
                !lines[0].StartsWith("flowchart ", StringComparison.OrdinalIgnoreCase))
                return null;

            var horizontal = lines[0].Contains(" LR", StringComparison.OrdinalIgnoreCase) ||
                             lines[0].Contains(" RL", StringComparison.OrdinalIgnoreCase);
            var nodes = new List<Node>();
            var nodeById = new Dictionary<string, Node>(StringComparer.OrdinalIgnoreCase);
            var edges = new List<Edge>();
            foreach (var statement in lines.Skip(1).SelectMany(line => line.Split(';', StringSplitOptions.RemoveEmptyEntries)))
            {
                var match = EdgePattern.Match(statement.Trim());
                if (!match.Success)
                    continue;
                var left = GetOrAddNode(match.Groups["left"].Value, nodes, nodeById);
                var right = GetOrAddNode(match.Groups["right"].Value, nodes, nodeById);
                edges.Add(new Edge(left, right, match.Groups["label"].Value.Trim()));
            }
            return nodes.Count >= 2 && edges.Count > 0 ? new MermaidDiagram(nodes, edges, horizontal) : null;
        }

        public UIElement CreateVisual()
        {
            const double nodeWidth = 150;
            const double nodeHeight = 54;
            const double gap = 52;
            var canvas = new Canvas
            {
                Width = _horizontal ? _nodes.Count * (nodeWidth + gap) : 260,
                Height = _horizontal ? nodeHeight + 84 : _nodes.Count * (nodeHeight + gap),
                Background = DiagramBackground
            };
            var positions = new Dictionary<Node, Point>();
            for (var index = 0; index < _nodes.Count; index++)
                positions[_nodes[index]] = _horizontal
                    ? new Point(20 + index * (nodeWidth + gap), 15)
                    : new Point(50, 15 + index * (nodeHeight + gap));

            foreach (var edge in _edges)
            {
                var from = positions[edge.From];
                var to = positions[edge.To];
                canvas.Children.Add(new Line
                {
                    X1 = from.X + (_horizontal ? nodeWidth : nodeWidth / 2),
                    Y1 = from.Y + (_horizontal ? nodeHeight / 2 : nodeHeight),
                    X2 = to.X + (_horizontal ? 0 : nodeWidth / 2),
                    Y2 = to.Y + (_horizontal ? nodeHeight / 2 : 0),
                    Stroke = DiagramLineBrush,
                    StrokeThickness = 2
                });
                if (!string.IsNullOrWhiteSpace(edge.Label))
                {
                    var label = new TextBlock { Text = edge.Label, Foreground = Brushes.White, FontSize = 12 };
                    Canvas.SetLeft(label, _horizontal ? (from.X + to.X + nodeWidth) / 2 - 15 : from.X + nodeWidth + 5);
                    Canvas.SetTop(label, _horizontal ? from.Y + 2 : (from.Y + to.Y) / 2);
                    canvas.Children.Add(label);
                }
            }

            foreach (var node in _nodes)
            {
                var point = positions[node];
                var border = new Border
                {
                    Width = nodeWidth,
                    Height = nodeHeight,
                    Background = DiagramNodeBrush,
                    BorderBrush = DiagramLineBrush,
                    BorderThickness = new Thickness(1),
                    CornerRadius = node.IsDecision ? new CornerRadius(0) : new CornerRadius(7),
                    Child = new TextBlock
                    {
                        Text = node.Label,
                        Foreground = Brushes.White,
                        TextAlignment = TextAlignment.Center,
                        TextWrapping = TextWrapping.Wrap,
                        VerticalAlignment = VerticalAlignment.Center,
                        Padding = new Thickness(6)
                    }
                };
                Canvas.SetLeft(border, point.X);
                Canvas.SetTop(border, point.Y);
                canvas.Children.Add(border);
            }

            return new Border
            {
                BorderBrush = TableBorderBrush,
                BorderThickness = new Thickness(1),
                Padding = new Thickness(8),
                Margin = new Thickness(0, 0, 0, 12),
                Child = canvas
            };
        }

        private static Node GetOrAddNode(string expression, List<Node> nodes, Dictionary<string, Node> nodeById)
        {
            var match = NodePattern.Match(expression.Trim());
            var id = match.Success ? match.Groups["id"].Value : expression.Trim();
            if (nodeById.TryGetValue(id, out var existing))
                return existing;
            var shape = match.Groups["shape"].Value;
            var label = shape.Length > 0 ? shape[1..^1].Trim('[', '(', ')', '{', '}', '"') : id;
            var node = new Node(id, label, shape.Contains('{', StringComparison.Ordinal));
            nodeById.Add(id, node);
            nodes.Add(node);
            return node;
        }

        private sealed record Node(string Id, string Label, bool IsDecision);
        private sealed record Edge(Node From, Node To, string Label);
    }
}
