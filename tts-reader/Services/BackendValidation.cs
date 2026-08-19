using TtsReader.Models;

namespace TtsReader.Services;

public static class BackendValidation
{
    public static bool IsConfigured(BackendDefinition backend) => GetErrorMessage(backend) is null;

    public static string? GetErrorMessage(BackendDefinition backend)
    {
        return backend.Engine switch
        {
            SpeechEngines.Windows => backend.BuiltIn
                ? null
                : "The Windows speech backend is not available on this system.",
            SpeechEngines.Piper => GetPiperError(backend),
            _ when SpeechEngines.IsLlmEngine(backend.Engine) => GetLlmError(backend),
            _ => $"The speech engine '{backend.Engine}' is not supported."
        };
    }

    public static void ThrowIfNotConfigured(BackendDefinition backend)
    {
        var error = GetErrorMessage(backend);
        if (error is not null)
            throw new InvalidDataException(error);
    }

    private static string? GetPiperError(BackendDefinition backend)
    {
        if (string.IsNullOrWhiteSpace(backend.ExecutablePath) || !File.Exists(backend.ExecutablePath))
            return "The configured Piper executable was not found.";
        if (string.IsNullOrWhiteSpace(backend.ModelPath) || !File.Exists(backend.ModelPath))
            return "The configured Piper ONNX model was not found.";
        if (!File.Exists(backend.ModelPath + ".json"))
            return "The Piper model configuration (.onnx.json) was not found.";
        return null;
    }

    private static string? GetLlmError(BackendDefinition backend)
    {
        var label = SpeechEngines.DisplayName(backend.Engine);
        if (string.IsNullOrWhiteSpace(backend.ExecutablePath))
            return $"The {label} Python executable is not configured.";
        if (!File.Exists(backend.ExecutablePath))
            return $"The {label} Python executable was not found at '{backend.ExecutablePath}'. " +
                   "Create the virtual environment and install the TTS package first (see the README).";
        if (string.IsNullOrWhiteSpace(backend.ModelPath))
            return $"The {label} model is not configured.";
        var model = backend.ModelPath.Trim();
        if (IsLocalModelReference(model) && !Directory.Exists(model) && !File.Exists(model))
            return $"The {label} model was not found at '{model}'.";
        if (backend.Engine == SpeechEngines.Qwen3Tts && string.IsNullOrWhiteSpace(backend.VoiceName))
            return "Qwen3-TTS needs a speaker name, a voice description, or a reference .wav path in the Voice field.";
        if (SpeechEngines.IsQwenVoiceClone(backend))
        {
            if (string.IsNullOrWhiteSpace(backend.VoiceName) || !File.Exists(backend.VoiceName))
                return "Qwen3-TTS voice clone needs an existing reference .wav path in the Voice field.";
            if (string.IsNullOrWhiteSpace(backend.Instruct))
                return "Qwen3-TTS voice clone needs the reference transcript in the Instruction field.";
        }
        if (backend.Engine == SpeechEngines.Chatterbox &&
            !string.IsNullOrWhiteSpace(backend.VoiceName) && !File.Exists(backend.VoiceName))
            return "The Chatterbox reference voice clip was not found.";
        if (SpeechEngines.IsChatterboxReferenceRequired(backend) && string.IsNullOrWhiteSpace(backend.VoiceName))
            return "Chatterbox Turbo and Nano need an existing reference .wav path in the Voice field.";
        return null;
    }

    // Hugging Face repo ids stay "available" before their first download; a
    // local model reference must already exist on this computer.
    private static bool IsLocalModelReference(string model) =>
        Path.IsPathRooted(model) || model.Contains('\\');
}
