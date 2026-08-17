namespace TtsReader.Models;

public sealed class BackendDefinition
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public required string Kind { get; set; }
    public string? VoiceName { get; set; }
    public bool BuiltIn { get; set; }
    public string Engine { get; set; } = SpeechEngines.Windows;
    public string? ExecutablePath { get; set; }
    public string? ModelPath { get; set; }

    public BackendDefinition Clone() => (BackendDefinition)MemberwiseClone();
}

public static class SpeechEngines
{
    public const string Windows = "windows";
    public const string Piper = "piper";
}
