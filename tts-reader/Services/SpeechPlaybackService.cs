using System.Speech.Synthesis;
using TtsReader.Models;

namespace TtsReader.Services;

public sealed class SpeechPlaybackService : ISpeechPlaybackService
{
    private SpeechSynthesizer? _synthesizer;
    private readonly object _gate = new();
    private int _activeCaretIndex;

    public event EventHandler<string>? PlaybackEnded;
    public event EventHandler<SpeechProgressEventArgs>? PlaybackProgress;

    private SpeechSynthesizer EnsureSynthesizer()
    {
        if (_synthesizer is not null)
            return _synthesizer;
        _synthesizer = new SpeechSynthesizer();
        _synthesizer.SetOutputToDefaultAudioDevice();
        _synthesizer.SpeakProgress += (_, args) =>
        {
            int characterIndex;
            lock (_gate)
                characterIndex = _activeCaretIndex + args.CharacterPosition;

            PlaybackProgress?.Invoke(this,
                new SpeechProgressEventArgs(characterIndex, args.CharacterCount));
        };
        _synthesizer.SpeakCompleted += (_, args) =>
        {
            if (!args.Cancelled && args.Error is null)
                PlaybackEnded?.Invoke(this, "Playback finished.");
            else if (args.Error is not null)
                PlaybackEnded?.Invoke(this, $"Playback failed: {args.Error.Message}");
        };
        return _synthesizer;
    }

    public void Speak(string text, int caretIndex, BackendDefinition backend, double playbackRate)
    {
        var remaining = GetTextFromCaret(text, caretIndex);

        lock (_gate)
        {
            var synthesizer = EnsureSynthesizer();
            synthesizer.SpeakAsyncCancelAll();
            _activeCaretIndex = caretIndex;
            synthesizer.Rate = MapPlaybackRate(playbackRate);
            synthesizer.SelectVoice(string.IsNullOrWhiteSpace(backend.VoiceName)
                ? synthesizer.Voice.Name
                : backend.VoiceName);
            synthesizer.SpeakAsync(remaining);
        }
    }

    public static int MapPlaybackRate(double playbackRate)
    {
        if (double.IsNaN(playbackRate) || double.IsInfinity(playbackRate) || playbackRate <= 0)
            throw new ArgumentOutOfRangeException(nameof(playbackRate));

        // System.Speech exposes an integer rate from -10 to 10 rather than a
        // multiplier. These values give the requested 1.0x, 1.25x, and 1.5x
        // choices a predictable stepped mapping.
        return Math.Clamp((int)Math.Round((playbackRate - 1.0) * 8.0), -10, 10);
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
