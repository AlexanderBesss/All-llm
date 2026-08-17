using System.Speech.Synthesis;
using TtsReader.Models;

namespace TtsReader.Services;

public sealed class SpeechPlaybackService : ISpeechPlaybackService
{
    private SpeechSynthesizer? _synthesizer;
    private readonly object _gate = new();
    private int _activeCaretIndex;
    private readonly ILocalProcessSpeechRunner _piperRunner;
    private readonly ILocalProcessSpeechRunner _llmRunner;
    private readonly IWaveAudioPlayer _audioPlayer;
    private CancellationTokenSource? _processCancellation;
    private int _playbackGeneration;

    public event EventHandler<string>? PlaybackEnded;
    public event EventHandler<SpeechProgressEventArgs>? PlaybackProgress;

    public SpeechPlaybackService(
        ILocalProcessSpeechRunner? piperRunner = null,
        ILocalProcessSpeechRunner? llmRunner = null,
        IWaveAudioPlayer? audioPlayer = null)
    {
        _piperRunner = piperRunner ?? new PiperProcessRunner();
        _llmRunner = llmRunner ?? new LlmTtsProcessRunner();
        _audioPlayer = audioPlayer ?? new WaveAudioPlayer();
    }

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

        if (SpeechEngines.IsLocalProcessEngine(backend.Engine))
        {
            StartLocalProcess(remaining, caretIndex, backend, playbackRate);
            return;
        }
        if (backend.Engine != SpeechEngines.Windows)
            throw new NotSupportedException($"Unknown speech engine '{backend.Engine}'.");

        lock (_gate)
        {
            CancelProcess();
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

    private void StartLocalProcess(string remaining, int caretIndex, BackendDefinition backend, double playbackRate)
    {
        if (double.IsNaN(playbackRate) || double.IsInfinity(playbackRate) || playbackRate <= 0)
            throw new ArgumentOutOfRangeException(nameof(playbackRate));
        if (backend.Engine == SpeechEngines.Piper)
            PiperProcessRunner.Validate(backend);
        else
            LlmTtsProcessRunner.Validate(backend);

        CancellationToken token;
        int generation;
        lock (_gate)
        {
            _synthesizer?.SpeakAsyncCancelAll();
            CancelProcess();
            _processCancellation = new CancellationTokenSource();
            token = _processCancellation.Token;
            generation = ++_playbackGeneration;
        }

        _ = RunLocalProcessAsync(remaining, caretIndex, backend, playbackRate, generation, token);
    }

    private async Task RunLocalProcessAsync(string text, int caretIndex, BackendDefinition backend,
        double playbackRate, int generation, CancellationToken token)
    {
        var runner = backend.Engine == SpeechEngines.Piper ? _piperRunner : _llmRunner;
        var tempDirectory = Path.Combine(Path.GetTempPath(), "TtsReader", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDirectory);
        try
        {
            foreach (var chunk in SplitIntoChunks(text))
            {
                token.ThrowIfCancellationRequested();
                var outputPath = Path.Combine(tempDirectory, "speech.wav");
                await runner.SynthesizeAsync(backend, chunk.Text, outputPath, playbackRate, token);
                PlaybackProgress?.Invoke(this,
                    new SpeechProgressEventArgs(caretIndex + chunk.Offset, chunk.Text.Length));
                await _audioPlayer.PlayAsync(outputPath, token);
            }
            if (IsCurrent(generation))
                PlaybackEnded?.Invoke(this, "Playback finished.");
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception exception)
        {
            if (IsCurrent(generation))
                PlaybackEnded?.Invoke(this, $"Playback failed: {exception.Message}");
        }
        finally
        {
            try { Directory.Delete(tempDirectory, true); } catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    public static IReadOnlyList<(string Text, int Offset)> SplitIntoChunks(string text, int maximumLength = 500)
    {
        if (maximumLength < 1) throw new ArgumentOutOfRangeException(nameof(maximumLength));
        var chunks = new List<(string Text, int Offset)>();
        var offset = 0;
        while (offset < text.Length)
        {
            while (offset < text.Length && char.IsWhiteSpace(text[offset])) offset++;
            if (offset >= text.Length) break;
            var length = Math.Min(maximumLength, text.Length - offset);
            if (offset + length < text.Length)
            {
                var boundary = text.LastIndexOfAny(['.', '!', '?', '\n', ' '], offset + length - 1, length);
                if (boundary >= offset) length = boundary - offset + 1;
            }
            var chunk = text.Substring(offset, length).TrimEnd();
            if (chunk.Length > 0) chunks.Add((chunk, offset));
            offset += length;
        }
        return chunks;
    }

    private bool IsCurrent(int generation)
    {
        lock (_gate) return generation == _playbackGeneration;
    }

    private void CancelProcess()
    {
        _playbackGeneration++;
        _processCancellation?.Cancel();
        _processCancellation?.Dispose();
        _processCancellation = null;
        _audioPlayer.Stop();
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
            CancelProcess();
        }
    }

    public void Dispose()
    {
        Stop();
        _synthesizer?.Dispose();
    }
}
