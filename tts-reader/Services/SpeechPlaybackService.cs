using System.Speech.Synthesis;
using System.Collections.Concurrent;
using TtsReader.Models;

namespace TtsReader.Services;

public sealed class SpeechPlaybackService : ISpeechPlaybackService
{
    private readonly object _gate = new();
    private readonly WindowsSpeechWorker _windowsSpeech;
    private readonly ILocalProcessSpeechRunner _piperRunner;
    private readonly ILocalProcessSpeechRunner _llmRunner;
    private readonly IWaveAudioPlayer _audioPlayer;
    private CancellationTokenSource? _processCancellation;
    private int _playbackGeneration;

    public event EventHandler<string>? PlaybackEnded;
    public event EventHandler<SpeechProgressEventArgs>? PlaybackProgress;
    public event EventHandler<string>? PlaybackStatus;

    public SpeechPlaybackService(
        ILocalProcessSpeechRunner? piperRunner = null,
        ILocalProcessSpeechRunner? llmRunner = null,
        IWaveAudioPlayer? audioPlayer = null)
    {
        _piperRunner = piperRunner ?? new PiperProcessRunner();
        _llmRunner = llmRunner ?? new LlmTtsProcessRunner();
        _audioPlayer = audioPlayer ?? new WaveAudioPlayer();
        _windowsSpeech = new WindowsSpeechWorker(
            (generation, characterIndex, characterCount) =>
            {
                if (IsCurrent(generation))
                    PlaybackProgress?.Invoke(this,
                        new SpeechProgressEventArgs(characterIndex, characterCount));
            },
            (generation, error) =>
            {
                if (!IsCurrent(generation))
                    return;
                PlaybackEnded?.Invoke(this, error is null
                    ? "Playback finished."
                    : $"Playback failed: {error.Message}");
            });
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

        int generation;
        lock (_gate)
        {
            CancelProcess();
            generation = ++_playbackGeneration;
        }
        // SpeechSynthesizer can spend seconds parsing a long document before
        // SpeakAsync returns. Its COM/SAPI calls must never run on the WPF
        // dispatcher, including cancellation and voice selection.
        _windowsSpeech.Speak(remaining, caretIndex, backend.VoiceName,
            MapPlaybackRate(playbackRate), generation);
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
            CancelProcess();
            _processCancellation = new CancellationTokenSource();
            token = _processCancellation.Token;
            generation = ++_playbackGeneration;
        }
        _windowsSpeech.Stop(generation);

        // Async methods run synchronously until their first incomplete await.
        // Piper's Process.Start and model initialization happen before that
        // boundary and used to execute directly on the WPF dispatcher. Put the
        // complete local-engine pipeline on a worker thread.
        _ = Task.Run(() => RunLocalProcessAsync(
            remaining, caretIndex, backend, playbackRate, generation, token));
    }

    private async Task RunLocalProcessAsync(string text, int caretIndex, BackendDefinition backend,
        double playbackRate, int generation, CancellationToken token)
    {
        var runner = backend.Engine == SpeechEngines.Piper ? _piperRunner : _llmRunner;
        var tempDirectory = Path.Combine(TtsReaderPaths.TempRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDirectory);
        try
        {
            await runner.PrepareAsync(backend, token);
            var chunks = SplitIntoChunks(text);
            for (var index = 0; index < chunks.Count; index++)
            {
                token.ThrowIfCancellationRequested();
                var chunk = chunks[index];
                if (IsCurrent(generation))
                    PlaybackStatus?.Invoke(this, index == 0
                        ? $"Synthesizing chunk {index + 1} of {chunks.Count}… first audio can take a while on the LLM engine"
                        : $"Synthesizing chunk {index + 1} of {chunks.Count}…");
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
        int generation;
        lock (_gate)
        {
            CancelProcess();
            generation = _playbackGeneration;
        }
        _windowsSpeech.Stop(generation);
    }

    public void Dispose()
    {
        Stop();
        (_piperRunner as IDisposable)?.Dispose();
        (_llmRunner as IDisposable)?.Dispose();
        _windowsSpeech.Dispose();
    }
}

/// <summary>
/// Owns System.Speech on a dedicated STA thread. No SAPI operation is allowed
/// to execute on (or synchronously block) the WPF dispatcher.
/// </summary>
internal sealed class WindowsSpeechWorker : IDisposable
{
    private readonly BlockingCollection<Action> _commands = new();
    private readonly Action<int, int, int> _progress;
    private readonly Action<int, Exception?> _completed;
    private readonly Thread _thread;
    private readonly Dictionary<Prompt, (int Generation, int CaretIndex)> _promptContexts = [];
    private SpeechSynthesizer? _synthesizer;
    private bool _disposed;

    public WindowsSpeechWorker(
        Action<int, int, int> progress,
        Action<int, Exception?> completed)
    {
        _progress = progress;
        _completed = completed;
        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "TTS Reader Windows speech"
        };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
    }

    public void Speak(string text, int caretIndex, string? voiceName, int rate, int generation) =>
        Enqueue(() =>
        {
            var synthesizer = EnsureSynthesizer();
            synthesizer.SpeakAsyncCancelAll();
            synthesizer.Rate = rate;
            if (!string.IsNullOrWhiteSpace(voiceName))
                synthesizer.SelectVoice(voiceName);
            var prompt = new Prompt(text);
            _promptContexts[prompt] = (generation, caretIndex);
            synthesizer.SpeakAsync(prompt);
        }, generation);

    public void Stop(int generation) => Enqueue(() =>
    {
        _synthesizer?.SpeakAsyncCancelAll();
    }, generation);

    private SpeechSynthesizer EnsureSynthesizer()
    {
        if (_synthesizer is not null)
            return _synthesizer;

        _synthesizer = new SpeechSynthesizer();
        _synthesizer.SetOutputToDefaultAudioDevice();
        _synthesizer.SpeakProgress += (_, args) =>
        {
            if (_promptContexts.TryGetValue(args.Prompt, out var context))
                _progress(context.Generation,
                    context.CaretIndex + args.CharacterPosition, args.CharacterCount);
        };
        _synthesizer.SpeakCompleted += (_, args) =>
        {
            if (!_promptContexts.Remove(args.Prompt, out var context) || args.Cancelled)
                return;
            _completed(context.Generation, args.Error);
        };
        return _synthesizer;
    }

    private void Enqueue(Action action, int generation)
    {
        if (_disposed)
            return;
        try
        {
            _commands.Add(() =>
            {
                try
                {
                    action();
                }
                catch (Exception exception)
                {
                    _completed(generation, exception);
                }
            });
        }
        catch (InvalidOperationException)
        {
            // Disposal completed the queue between the check and Add.
        }
    }

    private void Run()
    {
        foreach (var command in _commands.GetConsumingEnumerable())
            command();

        try
        {
            _synthesizer?.SpeakAsyncCancelAll();
            _synthesizer?.Dispose();
        }
        catch
        {
            // The application is already shutting down.
        }
    }

    public void Dispose()
    {
        if (_disposed)
            return;
        _disposed = true;
        _commands.CompleteAdding();
    }
}
