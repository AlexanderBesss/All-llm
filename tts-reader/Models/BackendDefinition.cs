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
    public string? Variant { get; set; }
    public string? Language { get; set; }
    public string? Instruct { get; set; }

    public BackendDefinition Clone() => (BackendDefinition)MemberwiseClone();
}

public static class SpeechEngines
{
    public const string Windows = "windows";
    public const string Piper = "piper";
    public const string Chatterbox = "chatterbox";
    public const string Qwen3Tts = "qwen3-tts";

    public static bool IsLocalProcessEngine(string? engine) =>
        engine == Piper || engine == Chatterbox || engine == Qwen3Tts;

    public static bool IsLlmEngine(string? engine) =>
        engine == Chatterbox || engine == Qwen3Tts;

    public static string NormalizeVariant(BackendDefinition backend) =>
        (backend.Variant ?? (backend.Engine == Qwen3Tts ? "custom-voice" : "base"))
        .Replace("-", string.Empty, StringComparison.Ordinal)
        .ToLowerInvariant();

    public static bool IsQwenVoiceClone(BackendDefinition backend) =>
        backend.Engine == Qwen3Tts && NormalizeVariant(backend).Contains("clone", StringComparison.Ordinal);

    public static bool IsQwenVoiceDesign(BackendDefinition backend) =>
        backend.Engine == Qwen3Tts && NormalizeVariant(backend).Contains("design", StringComparison.Ordinal);

    public static bool IsChatterboxReferenceRequired(BackendDefinition backend) =>
        backend.Engine == Chatterbox &&
        (NormalizeVariant(backend).Contains("turbo", StringComparison.Ordinal) ||
         NormalizeVariant(backend).Contains("nano", StringComparison.Ordinal));

    public static string DisplayName(string? engine) => engine switch
    {
        Piper => "Piper",
        Chatterbox => "Chatterbox",
        Qwen3Tts => "Qwen3-TTS",
        _ => "Windows Speech"
    };
}
