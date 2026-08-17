namespace TtsReader.Models;

public sealed class ReaderSettings
{
    public string ActiveBackendId { get; set; } = "windows-default";
    public List<BackendDefinition> Backends { get; set; } = [];
    public string? LastFolderPath { get; set; }
    public string? LastSelectedFilePath { get; set; }
}
