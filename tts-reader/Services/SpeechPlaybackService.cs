using System.Speech.Synthesis;
using TtsReader.Models;

namespace TtsReader.Services;

public sealed class SpeechPlaybackService : IDisposable
{
    private SpeechSynthesizer? _synthesizer;
    private readonly object _gate = new();

    public event EventHandler<string>? PlaybackEnded;

    private SpeechSynthesizer EnsureSynthesizer()
    {
        if (_synthesizer is not null)
            return _synthesizer;
        _synthesizer = new SpeechSynthesizer();
        _synthesizer.SetOutputToDefaultAudioDevice();
        _synthesizer.SpeakCompleted += (_, args) =>
        {
            if (!args.Cancelled && args.Error is null)
                PlaybackEnded?.Invoke(this, "Playback finished.");
            else if (args.Error is not null)
                PlaybackEnded?.Invoke(this, $"Playback failed: {args.Error.Message}");
        };
        return _synthesizer;
    }

    public void Speak(string text, int caretIndex, BackendDefinition backend)
    {
        var remaining = GetTextFromCaret(text, caretIndex);

        lock (_gate)
        {
            var synthesizer = EnsureSynthesizer();
            synthesizer.SpeakAsyncCancelAll();
            synthesizer.SelectVoice(string.IsNullOrWhiteSpace(backend.VoiceName)
                ? synthesizer.Voice.Name
                : backend.VoiceName);
            synthesizer.SpeakAsync(remaining);
        }
    }

    public static string GetTextFromCaret(string text, int caretIndex)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (caretIndex < 0 || caretIndex > text.Length)
            throw new ArgumentOutOfRangeException(nameof(caretIndex));
        var remaining = text[caretIndex..];
        if (string.IsNullOrWhiteSpace(remaining))
            throw new InvalidOperationException("There is no readable text after the caret.");
        return remaining;
    }

    public void Stop()
    {
        lock (_gate)
        {
            _synthesizer?.SpeakAsyncCancelAll();
        }
    }

    public void Dispose()
    {
        Stop();
        _synthesizer?.Dispose();
    }
}
