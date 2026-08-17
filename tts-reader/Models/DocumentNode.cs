using System.Collections.ObjectModel;

namespace TtsReader.Models;

public sealed class DocumentNode
{
    public required string Name { get; init; }
    public string? FullPath { get; init; }
    public bool IsFolder { get; init; }
    public ObservableCollection<DocumentNode> Children { get; } = [];
}
