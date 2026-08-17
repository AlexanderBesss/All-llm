using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using IOPath = System.IO.Path;

namespace TtsReader.Services;

/// <summary>
/// Turns Markdown into a native WPF FlowDocument. Keeping the rendered document
/// in a RichTextBox means the visible content still has a useful caret for TTS.
/// </summary>
public sealed class MarkdownDocumentRenderer
{
    private static readonly Regex HeadingPattern = new(@"^\s{0,3}(?<marks>#{1,6})\s+(?<text>.*?)(?:\s+#+)?\s*$", RegexOptions.Compiled);
    private static readonly Regex FencePattern = new(@"^\s{0,3}(?<fence>`{3,}|~{3,})\s*(?<language>[^\s]+)?.*$", RegexOptions.Compiled);
    private static readonly Regex ListPattern = new(@"^(?<indent>\s*)(?<marker>[-+*]|\d+[.)])\s+(?<text>.*)$", RegexOptions.Compiled);
    private static readonly Regex TableSeparatorPattern = new(@"^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$", RegexOptions.Compiled);
    private static readonly Regex MermaidEdgePattern = new(
        @"(?<left>[A-Za-z0-9_]+(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|\(\([^)]*\)\)))?)\s*(?<arrow>-->|-.->|==>|--|---)\s*(?<right>[A-Za-z0-9_]+(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|\(\([^)]*\)\)))?)(?:\s*\|(?<label>[^|]+)\|)?",
        RegexOptions.Compiled);
    private static readonly Regex MermaidNodePattern = new(
        @"(?<id>[A-Za-z0-9_]+)\s*(?<shape>\[\[[^\]]*\]\]|\[\([^]]*\)\]|\[\{[^}]*\}\]|\(\([^)]*\)\)|\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?",
        RegexOptions.Compiled);

    private static readonly Brush HeadingBrush = new SolidColorBrush(Color.FromRgb(88, 196, 255));
    private static readonly Brush MutedBrush = new SolidColorBrush(Color.FromRgb(175, 183, 196));
    private static readonly Brush CodeBackground = new SolidColorBrush(Color.FromRgb(39, 43, 51));
    private static readonly Brush TableBorderBrush = new SolidColorBrush(Color.FromRgb(78, 86, 101));
    private static readonly Brush TableHeaderBrush = new SolidColorBrush(Color.FromRgb(49, 56, 68));
    private static readonly Brush DiagramBackground = new SolidColorBrush(Color.FromRgb(31, 36, 45));
    private static readonly Brush DiagramNodeBrush = new SolidColorBrush(Color.FromRgb(49, 75, 98));
    private static readonly Brush DiagramLineBrush = new SolidColorBrush(Color.FromRgb(124, 196, 234));

    public FlowDocument Render(string markdown, string? sourcePath = null)
    {
        ArgumentNullException.ThrowIfNull(markdown);

        var document = CreateDocument();
        var lines = markdown.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Split('\n');
        var sourceDirectory = string.IsNullOrWhiteSpace(sourcePath)
            ? null
            : IOPath.GetDirectoryName(IOPath.GetFullPath(sourcePath));

        RenderBlocks(lines, document.Blocks, sourceDirectory);
        return document;
    }

    public FlowDocument RenderPlainText(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        var document = CreateDocument();
        var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Split('\n');
        foreach (var line in lines)
            document.Blocks.Add(new Paragraph(new Run(line)) { Margin = new Thickness(0, 0, 0, 8) });
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

    private static void RenderBlocks(IReadOnlyList<string> lines, BlockCollection blocks, string? sourceDirectory)
    {
        for (var index = 0; index < lines.Count;)
        {
            if (string.IsNullOrWhiteSpace(lines[index]))
            {
                index++;
                continue;
            }

            var heading = HeadingPattern.Match(lines[index]);
            if (heading.Success)
            {
                var level = heading.Groups["marks"].Length;
                var paragraph = new Paragraph
                {
                    Margin = new Thickness(0, level == 1 ? 14 : 9, 0, level == 1 ? 10 : 6),
                    FontSize = Math.Max(16, 30 - (level * 2)),
                    FontWeight = FontWeights.SemiBold,
                    Foreground = HeadingBrush
                };
                AddInline(paragraph.Inlines, heading.Groups["text"].Value, sourceDirectory);
                blocks.Add(paragraph);
                index++;
                continue;
            }

            var fence = FencePattern.Match(lines[index]);
            if (fence.Success)
            {
                var fenceCharacter = fence.Groups["fence"].Value[0];
                var language = fence.Groups["language"].Value;
                var code = new List<string>();
                index++;
                while (index < lines.Count && !IsClosingFence(lines[index], fenceCharacter))
                    code.Add(lines[index++]);
                if (index < lines.Count)
                    index++;

                if (language.Equals("mermaid", StringComparison.OrdinalIgnoreCase))
                    AddMermaidDiagram(blocks, code);
                else
                    AddCodeBlock(blocks, string.Join(Environment.NewLine, code), language);
                continue;
            }

            if (IsThematicBreak(lines[index]))
            {
                blocks.Add(new Paragraph(new Run("────────────────────────────────────────"))
                {
                    Foreground = MutedBrush,
                    Margin = new Thickness(0, 8, 0, 8)
                });
                index++;
                continue;
            }

            if (IsTableStart(lines, index))
            {
                index = AddTable(blocks, lines, index, sourceDirectory);
                continue;
            }

            if (IsQuoteLine(lines[index]))
            {
                var quote = new Paragraph
                {
                    Margin = new Thickness(18, 2, 0, 8),
                    Padding = new Thickness(12, 2, 0, 2),
                    BorderBrush = HeadingBrush,
                    BorderThickness = new Thickness(2, 0, 0, 0),
                    Foreground = MutedBrush
                };
                while (index < lines.Count && IsQuoteLine(lines[index]))
                {
                    if (quote.Inlines.Count > 0)
                        quote.Inlines.Add(new LineBreak());
                    AddInline(quote.Inlines, RemoveQuotePrefix(lines[index++]), sourceDirectory);
                }
                blocks.Add(quote);
                continue;
            }

            var listMatch = ListPattern.Match(lines[index]);
            if (listMatch.Success)
            {
                index = AddList(blocks, lines, index, sourceDirectory, listMatch);
                continue;
            }

            var paragraphLines = new List<string>();
            while (index < lines.Count &&
                   !string.IsNullOrWhiteSpace(lines[index]) &&
                   !IsBlockStart(lines, index))
            {
                paragraphLines.Add(lines[index++].Trim());
            }

            if (paragraphLines.Count > 0)
            {
                var paragraph = new Paragraph { Margin = new Thickness(0, 0, 0, 9) };
                for (var lineIndex = 0; lineIndex < paragraphLines.Count; lineIndex++)
                {
                    if (lineIndex > 0)
                        paragraph.Inlines.Add(new Run(" "));
                    AddInline(paragraph.Inlines, paragraphLines[lineIndex], sourceDirectory);
                }
                blocks.Add(paragraph);
            }
            else
            {
                index++;
            }
        }
    }

    private static bool IsBlockStart(IReadOnlyList<string> lines, int index)
    {
        return HeadingPattern.IsMatch(lines[index]) ||
               FencePattern.IsMatch(lines[index]) ||
               IsThematicBreak(lines[index]) ||
               IsQuoteLine(lines[index]) ||
               ListPattern.IsMatch(lines[index]) ||
               IsTableStart(lines, index);
    }

    private static bool IsClosingFence(string line, char fenceCharacter) =>
        line.TrimStart().StartsWith(new string(fenceCharacter, 3), StringComparison.Ordinal);

    private static bool IsThematicBreak(string line)
    {
        var trimmed = line.Trim();
        if (trimmed.Length < 3)
            return false;
        return trimmed.All(character => character is '-' or '*' or '_') &&
               trimmed.Count(character => character != ' ') >= 3;
    }

    private static bool IsQuoteLine(string line) => line.TrimStart().StartsWith('>');

    private static string RemoveQuotePrefix(string line)
    {
        var trimmed = line.TrimStart();
        return trimmed.Length > 1 ? trimmed[1..].TrimStart() : string.Empty;
    }

    private static int AddList(BlockCollection blocks, IReadOnlyList<string> lines, int index,
        string? sourceDirectory, Match firstMatch)
    {
        var ordered = char.IsDigit(firstMatch.Groups["marker"].Value[0]);
        var list = new System.Windows.Documents.List
        {
            MarkerStyle = ordered ? TextMarkerStyle.Decimal : TextMarkerStyle.Disc,
            Margin = new Thickness(12, 0, 0, 9),
            Padding = new Thickness(12, 0, 0, 0)
        };
        var baseIndent = firstMatch.Groups["indent"].Value.Length;

        while (index < lines.Count)
        {
            var match = ListPattern.Match(lines[index]);
            if (!match.Success || match.Groups["indent"].Value.Length != baseIndent ||
                char.IsDigit(match.Groups["marker"].Value[0]) != ordered)
                break;

            var itemText = match.Groups["text"].Value;
            var task = Regex.Match(itemText, @"^\[(?<mark>[ xX])\]\s+(?<text>.*)$");
            if (task.Success)
                itemText = $"{(task.Groups["mark"].Value.Equals("x", StringComparison.OrdinalIgnoreCase) ? "☑" : "☐")} {task.Groups["text"].Value}";

            var item = new ListItem();
            var paragraph = new Paragraph { Margin = new Thickness(0, 0, 0, 3) };
            AddInline(paragraph.Inlines, itemText, sourceDirectory);
            item.Blocks.Add(paragraph);
            list.ListItems.Add(item);
            index++;

            while (index < lines.Count &&
                   !string.IsNullOrWhiteSpace(lines[index]) &&
                   lines[index].Length > baseIndent &&
                   !ListPattern.IsMatch(lines[index]) &&
                   !IsBlockStart(lines, index))
            {
                var continuation = new Paragraph { Margin = new Thickness(0, 0, 0, 3) };
                AddInline(continuation.Inlines, lines[index++].Trim(), sourceDirectory);
                item.Blocks.Add(continuation);
            }
        }

        blocks.Add(list);
        return index;
    }

    private static bool IsTableStart(IReadOnlyList<string> lines, int index) =>
        index + 1 < lines.Count &&
        lines[index].Contains('|', StringComparison.Ordinal) &&
        TableSeparatorPattern.IsMatch(lines[index + 1]);

    private static int AddTable(BlockCollection blocks, IReadOnlyList<string> lines, int index, string? sourceDirectory)
    {
        var headers = SplitTableCells(lines[index++]);
        var alignment = SplitTableCells(lines[index++]);
        var rows = new List<IReadOnlyList<string>>();
        while (index < lines.Count && !string.IsNullOrWhiteSpace(lines[index]) && lines[index].Contains('|', StringComparison.Ordinal))
            rows.Add(SplitTableCells(lines[index++]));

        var columnCount = Math.Max(headers.Count, rows.Select(row => row.Count).DefaultIfEmpty(0).Max());
        if (columnCount == 0)
            return index;

        var table = new Table
        {
            CellSpacing = 0,
            Margin = new Thickness(0, 2, 0, 12),
            BorderBrush = TableBorderBrush,
            BorderThickness = new Thickness(1)
        };
        for (var column = 0; column < columnCount; column++)
            table.Columns.Add(new TableColumn { Width = new GridLength(1, GridUnitType.Star) });

        var headerGroup = new TableRowGroup();
        headerGroup.Rows.Add(CreateTableRow(headers, columnCount, sourceDirectory, isHeader: true));
        table.RowGroups.Add(headerGroup);
        if (rows.Count > 0)
        {
            var bodyGroup = new TableRowGroup();
            foreach (var row in rows)
                bodyGroup.Rows.Add(CreateTableRow(row, columnCount, sourceDirectory, isHeader: false));
            table.RowGroups.Add(bodyGroup);
        }

        blocks.Add(table);
        return index;
    }

    private static TableRow CreateTableRow(IReadOnlyList<string> values, int columnCount, string? sourceDirectory,
        bool isHeader)
    {
        var row = new TableRow();
        for (var column = 0; column < columnCount; column++)
        {
            var cell = new TableCell
            {
                Padding = new Thickness(8, 5, 8, 5),
                BorderBrush = TableBorderBrush,
                BorderThickness = new Thickness(0.5),
                Background = isHeader ? TableHeaderBrush : Brushes.Transparent
            };
            var paragraph = new Paragraph { Margin = new Thickness(0) };
            if (isHeader)
            {
                var bold = new Bold();
                AddInline(bold.Inlines, column < values.Count ? values[column] : string.Empty, sourceDirectory);
                paragraph.Inlines.Add(bold);
            }
            else
            {
                AddInline(paragraph.Inlines, column < values.Count ? values[column] : string.Empty, sourceDirectory);
            }
            cell.Blocks.Add(paragraph);
            row.Cells.Add(cell);
        }
        return row;
    }

    private static IReadOnlyList<string> SplitTableCells(string line)
    {
        var trimmed = line.Trim();
        if (trimmed.StartsWith('|'))
            trimmed = trimmed[1..];
        if (trimmed.EndsWith('|'))
            trimmed = trimmed[..^1];

        var cells = new List<string>();
        var current = new StringBuilder();
        var escaped = false;
        var inCode = false;
        foreach (var character in trimmed)
        {
            if (escaped)
            {
                current.Append(character);
                escaped = false;
            }
            else if (character == '\\')
            {
                escaped = true;
                current.Append(character);
            }
            else if (character == '`')
            {
                inCode = !inCode;
                current.Append(character);
            }
            else if (character == '|' && !inCode)
            {
                cells.Add(current.ToString().Trim());
                current.Clear();
            }
            else
            {
                current.Append(character);
            }
        }
        cells.Add(current.ToString().Trim());
        return cells;
    }

    private static void AddCodeBlock(BlockCollection blocks, string code, string language)
    {
        var panel = new StackPanel();
        if (!string.IsNullOrWhiteSpace(language))
        {
            panel.Children.Add(new TextBlock
            {
                Text = language,
                Foreground = HeadingBrush,
                FontSize = 12,
                Margin = new Thickness(0, 0, 0, 4)
            });
        }
        panel.Children.Add(new TextBlock
        {
            Text = code,
            Foreground = Brushes.White,
            FontFamily = new FontFamily("Consolas"),
            TextWrapping = TextWrapping.NoWrap
        });

        blocks.Add(new BlockUIContainer(new Border
        {
            Background = CodeBackground,
            CornerRadius = new CornerRadius(4),
            Padding = new Thickness(12),
            Margin = new Thickness(0, 2, 0, 10),
            Child = panel
        }));
        blocks.Add(new Paragraph(new Run(code))
        {
            Foreground = Brushes.Transparent,
            FontSize = 1,
            Margin = new Thickness(0, -1, 0, -1)
        });
    }

    private static void AddMermaidDiagram(BlockCollection blocks, IReadOnlyList<string> sourceLines)
    {
        var source = string.Join(Environment.NewLine, sourceLines);
        var diagram = MermaidDiagram.TryCreate(source);
        if (diagram is null)
        {
            AddCodeBlock(blocks, source, "mermaid");
            return;
        }

        var description = diagram.Description;
        blocks.Add(new Paragraph(new Run($"Diagram: {description}"))
        {
            Foreground = MutedBrush,
            FontStyle = FontStyles.Italic,
            Margin = new Thickness(0, 2, 0, 4)
        });
        blocks.Add(new BlockUIContainer(diagram.CreateVisual()));
    }

    private static void AddInline(InlineCollection inlines, string text, string? sourceDirectory)
    {
        for (var index = 0; index < text.Length;)
        {
            if (text[index] == '\\' && index + 1 < text.Length && IsMarkdownPunctuation(text[index + 1]))
            {
                inlines.Add(new Run(text[index + 1].ToString()));
                index += 2;
                continue;
            }

            if (TryAddImage(inlines, text, ref index, sourceDirectory) ||
                TryAddLink(inlines, text, ref index) ||
                TryAddDelimited(inlines, text, ref index, "**", isBold: true) ||
                TryAddDelimited(inlines, text, ref index, "__", isBold: true) ||
                TryAddDelimited(inlines, text, ref index, "~~", isStrike: true) ||
                TryAddDelimited(inlines, text, ref index, "`", isCode: true) ||
                TryAddDelimited(inlines, text, ref index, "*", isItalic: true) ||
                TryAddDelimited(inlines, text, ref index, "_", isItalic: true))
                continue;

            var start = index++;
            while (index < text.Length && text[index] != '\\' &&
                   !"![]`*_~".Contains(text[index], StringComparison.Ordinal))
                index++;
            if (start == index)
            {
                inlines.Add(new Run(text[index].ToString()));
                index++;
            }
            else
            {
                inlines.Add(new Run(text[start..index]));
            }
        }
    }

    private static bool TryAddDelimited(InlineCollection inlines, string text, ref int index, string delimiter,
        bool isBold = false, bool isItalic = false, bool isStrike = false, bool isCode = false)
    {
        if (!text.AsSpan(index).StartsWith(delimiter, StringComparison.Ordinal))
            return false;
        var end = text.IndexOf(delimiter, index + delimiter.Length, StringComparison.Ordinal);
        if (end <= index + delimiter.Length)
            return false;

        var value = text.Substring(index + delimiter.Length, end - index - delimiter.Length);
        Inline inline;
        if (isCode)
        {
            inline = new Run(value)
            {
                FontFamily = new FontFamily("Consolas"),
                Background = CodeBackground,
                Foreground = Brushes.White
            };
        }
        else
        {
            var span = isBold ? new Bold() : isItalic ? new Italic() : new Span();
            if (isStrike)
                span.TextDecorations = TextDecorations.Strikethrough;
            AddInline(span.Inlines, value, null);
            inline = span;
        }

        inlines.Add(inline);
        index = end + delimiter.Length;
        return true;
    }

    private static bool TryAddLink(InlineCollection inlines, string text, ref int index)
    {
        if (text[index] != '[' || index > 0 && text[index - 1] == '!')
            return false;
        var labelEnd = text.IndexOf(']', index + 1);
        if (labelEnd < 0 || labelEnd + 1 >= text.Length || text[labelEnd + 1] != '(')
            return false;
        var targetEnd = text.IndexOf(')', labelEnd + 2);
        if (targetEnd < 0)
            return false;

        var label = text.Substring(index + 1, labelEnd - index - 1);
        var target = text.Substring(labelEnd + 2, targetEnd - labelEnd - 2).Trim();
        var titleSeparator = target.IndexOfAny([' ', '\t']);
        if (titleSeparator >= 0)
            target = target[..titleSeparator];
        var hyperlink = new Hyperlink { Foreground = HeadingBrush };
        if (Uri.TryCreate(target, UriKind.RelativeOrAbsolute, out var uri))
            hyperlink.NavigateUri = uri;
        AddInline(hyperlink.Inlines, label, null);
        inlines.Add(hyperlink);
        index = targetEnd + 1;
        return true;
    }

    private static bool TryAddImage(InlineCollection inlines, string text, ref int index, string? sourceDirectory)
    {
        if (!text.AsSpan(index).StartsWith("![", StringComparison.Ordinal))
            return false;
        var altEnd = text.IndexOf(']', index + 2);
        if (altEnd < 0 || altEnd + 1 >= text.Length || text[altEnd + 1] != '(')
            return false;
        var targetEnd = text.IndexOf(')', altEnd + 2);
        if (targetEnd < 0)
            return false;

        var alt = text.Substring(index + 2, altEnd - index - 2);
        var target = text.Substring(altEnd + 2, targetEnd - altEnd - 2).Trim();
        var titleSeparator = target.IndexOfAny([' ', '\t']);
        if (titleSeparator >= 0)
            target = target[..titleSeparator];

        var imagePath = ResolveImagePath(target, sourceDirectory);
        if (imagePath is not null)
        {
            try
            {
                var imageSource = new BitmapImage();
                imageSource.BeginInit();
                imageSource.CacheOption = BitmapCacheOption.OnLoad;
                imageSource.UriSource = new Uri(imagePath, UriKind.Absolute);
                imageSource.EndInit();
                imageSource.Freeze();
                inlines.Add(new InlineUIContainer(new Image
                {
                    Source = imageSource,
                    MaxWidth = 720,
                    MaxHeight = 480,
                    Stretch = Stretch.Uniform,
                    ToolTip = alt
                }));
            }
            catch (Exception) when (imagePath is not null)
            {
                inlines.Add(new Run($"[Image: {alt}]") { Foreground = MutedBrush });
            }
        }
        else
        {
            inlines.Add(new Run($"[Image: {alt}]") { Foreground = MutedBrush });
        }

        index = targetEnd + 1;
        return true;
    }

    private static string? ResolveImagePath(string target, string? sourceDirectory)
    {
        if (Uri.TryCreate(target, UriKind.Absolute, out var uri) && uri.IsFile)
            return uri.LocalPath;
        if (Uri.TryCreate(target, UriKind.Absolute, out uri) && uri.Scheme is "http" or "https")
            return null;
        if (string.IsNullOrWhiteSpace(sourceDirectory) || string.IsNullOrWhiteSpace(target))
            return null;
        var path = IOPath.GetFullPath(IOPath.Combine(sourceDirectory, target.Replace('/', IOPath.DirectorySeparatorChar)));
        return File.Exists(path) ? path : null;
    }

    private static bool IsMarkdownPunctuation(char character) => "\\`*_{}[]<>()#+-.!|~".Contains(character, StringComparison.Ordinal);

    private sealed class MermaidDiagram
    {
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
                .Select(line => line.Trim())
                .Where(line => line.Length > 0 && !line.StartsWith("%%", StringComparison.Ordinal))
                .ToList();
            if (lines.Count == 0 || !lines[0].StartsWith("graph ", StringComparison.OrdinalIgnoreCase) &&
                !lines[0].StartsWith("flowchart ", StringComparison.OrdinalIgnoreCase))
                return null;

            var horizontal = lines[0].Contains(" LR", StringComparison.OrdinalIgnoreCase) ||
                             lines[0].Contains(" RL", StringComparison.OrdinalIgnoreCase);
            var nodes = new List<Node>();
            var nodeById = new Dictionary<string, Node>(StringComparer.OrdinalIgnoreCase);
            var edges = new List<Edge>();

            foreach (var line in lines.Skip(1))
            {
                var edgeMatch = MermaidEdgePattern.Match(line);
                if (!edgeMatch.Success)
                    continue;
                var left = GetOrAddNode(edgeMatch.Groups["left"].Value, nodes, nodeById);
                var right = GetOrAddNode(edgeMatch.Groups["right"].Value, nodes, nodeById);
                edges.Add(new Edge(left, right, edgeMatch.Groups["label"].Value.Trim()));
            }

            if (nodes.Count < 2 || edges.Count == 0)
                return null;
            return new MermaidDiagram(nodes, edges, horizontal);
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
                Background = DiagramBackground,
                Margin = new Thickness(0)
            };
            var positions = new Dictionary<Node, Point>();
            for (var index = 0; index < _nodes.Count; index++)
            {
                var point = _horizontal
                    ? new Point(20 + index * (nodeWidth + gap), 15)
                    : new Point(50, 15 + index * (nodeHeight + gap));
                positions[_nodes[index]] = point;
            }

            foreach (var edge in _edges)
            {
                var from = positions[edge.From];
                var to = positions[edge.To];
                var line = new Line
                {
                    X1 = from.X + (_horizontal ? nodeWidth : nodeWidth / 2),
                    Y1 = from.Y + (_horizontal ? nodeHeight / 2 : nodeHeight),
                    X2 = to.X + (_horizontal ? 0 : nodeWidth / 2),
                    Y2 = to.Y + (_horizontal ? nodeHeight / 2 : 0),
                    Stroke = DiagramLineBrush,
                    StrokeThickness = 2
                };
                canvas.Children.Add(line);
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
                    CornerRadius = node.Shape == NodeShape.Decision ? new CornerRadius(0) : new CornerRadius(7),
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
            var match = MermaidNodePattern.Match(expression.Trim());
            var id = match.Success ? match.Groups["id"].Value : expression.Trim();
            if (nodeById.TryGetValue(id, out var existing))
                return existing;

            var shape = match.Groups["shape"].Value;
            var label = shape.Length > 0 ? shape[1..^1].Trim('[', '(', ')', '{', '}') : id;
            var node = new Node(id, label, shape.Contains('{', StringComparison.Ordinal) ? NodeShape.Decision : NodeShape.Rectangle);
            nodeById.Add(id, node);
            nodes.Add(node);
            return node;
        }

        private sealed record Node(string Id, string Label, NodeShape Shape);
        private sealed record Edge(Node From, Node To, string Label);
        private enum NodeShape { Rectangle, Decision }
    }
}
