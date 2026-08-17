namespace TtsReader.Models;

public sealed class BackendDefinition
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public required string Kind { get; set; }
    public string? VoiceName { get; set; }
    public string? DownloadSource { get; set; }
    public string? PackageFileName { get; set; }
    public bool BuiltIn { get; set; }

    public BackendDefinition Clone() => (BackendDefinition)MemberwiseClone();
}
