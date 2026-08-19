namespace TtsReader.Models;

public sealed class ReaderSettings
{
    public string ActiveBackendId { get; set; } = "windows-default";
    public List<BackendDefinition> Backends { get; set; } = [];
    public double PlaybackRate { get; set; } = 1.0;
    public string? LastFolderPath { get; set; }
    public string? LastSelectedFilePath { get; set; }

    public ReaderSettings Clone() => new()
    {
        ActiveBackendId = ActiveBackendId,
        Backends = Backends.Select(backend => backend.Clone()).ToList(),
        PlaybackRate = PlaybackRate,
        LastFolderPath = LastFolderPath,
        LastSelectedFilePath = LastSelectedFilePath
    };
}
