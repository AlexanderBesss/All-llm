using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using TtsReader.Models;

namespace TtsReader.Services;

/// <summary>
/// Keeps one Qwen3-TTS worker process alive across chunks so the model is
/// loaded once instead of once per ~500-character chunk.
/// </summary>
public sealed class QwenTtsWorkerRunner : ILocalProcessSpeechRunner, IDisposable
{
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromMinutes(15);
    private static readonly int MaxConsecutiveFailures = 3;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _requestGate = new(1, 1);
    private readonly string _logPath;
    private int _consecutiveFailures;
    private long _nextId;
    private Process? _worker;

    public QwenTtsWorkerRunner()
        : this(Path.Combine(TtsReaderPaths.LogsRoot, $"qwen-worker-{DateTime.Now:yyyyMMdd-HHmmss}.log"))
    {
    }

    public QwenTtsWorkerRunner(string logPath)
    {
        _logPath = logPath;
    }

    public async Task PrepareAsync(BackendDefinition backend, CancellationToken cancellationToken)
    {
        BackendValidation.ThrowIfNotConfigured(backend);
        await EnsureWorkerAsync(backend);
        await Task.CompletedTask;
    }

    public async Task SynthesizeAsync(
        BackendDefinition backend,
        string text,
        string outputPath,
        double playbackRate,
        CancellationToken cancellationToken)
    {
        BackendValidation.ThrowIfNotConfigured(backend);
        await EnsureWorkerAsync(backend);
        await _requestGate.WaitAsync(cancellationToken);
        try
        {
            var worker = CurrentWorker();
            var request = new TtsWorkerRequest
            {
                Text = text,
                Output = outputPath,
                Rate = playbackRate,
                Speaker = string.IsNullOrWhiteSpace(backend.VoiceName) ? null : backend.VoiceName,
                Language = string.IsNullOrWhiteSpace(backend.Language) ? null : backend.Language,
                Instruct = string.IsNullOrWhiteSpace(backend.Instruct) ? null : backend.Instruct,
                RefAudio = SpeechEngines.IsQwenVoiceClone(backend)
                    ? (string.IsNullOrWhiteSpace(backend.VoiceName) ? null : backend.VoiceName)
                    : null,
                RefText = SpeechEngines.IsQwenVoiceClone(backend)
                    ? (string.IsNullOrWhiteSpace(backend.Instruct) ? null : backend.Instruct)
                    : null
            };
            lock (_gate)
            {
                request.Id = ++_nextId;
            }

            var stdin = worker.StandardInput;
            try
            {
                await stdin.WriteLineAsync(JsonSerializer.Serialize(request));
                await stdin.FlushAsync();
            }
            catch (Exception exception) when (exception is IOException or ObjectDisposedException)
            {
                throw new InvalidOperationException(
                    "The Qwen3-TTS worker closed its input unexpectedly. " + TailOfLog(), exception);
            }

            using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutSource.CancelAfter(RequestTimeout);
            while (true)
            {
                string? line;
                try
                {
                    line = await worker.StandardOutput.ReadLineAsync(timeoutSource.Token);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    throw new TimeoutException(
                        $"Qwen3-TTS synthesis took longer than {RequestTimeout.TotalMinutes:0} minutes.");
                }
                if (line is null)
                    throw new InvalidOperationException("The Qwen3-TTS worker exited before answering. " + TailOfLog());
                if (string.IsNullOrWhiteSpace(line) || line[0] is not '{')
                    continue;
                var response = JsonSerializer.Deserialize<TtsWorkerResponse>(line);
                if (response is null || response.Id != request.Id)
                    continue;
                if (response.Ok is not true)
                {
                    _consecutiveFailures++;
                    throw new InvalidOperationException($"Qwen3-TTS worker error: {response.Error}");
                }
                if (!File.Exists(outputPath) || new FileInfo(outputPath).Length == 0)
                    throw new InvalidDataException("Qwen3-TTS worker did not produce a WAV file.");
                _consecutiveFailures = 0;
                return;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            AbandonWorker();
            throw;
        }
        catch (TimeoutException)
        {
            AbandonWorker();
            throw;
        }
        finally
        {
            _requestGate.Release();
        }
    }

    private void AbandonWorker()
    {
        Process? worker;
        lock (_gate)
        {
            worker = _worker;
            _worker = null;
        }
        if (worker is not null)
        {
            try { worker.Kill(entireProcessTree: true); }
            catch
            {
                // Best effort.
            }
            worker.Dispose();
        }
    }

    private Process CurrentWorker()
    {
        lock (_gate)
        {
            return _worker ?? throw new InvalidOperationException("The Qwen3-TTS worker is not running.");
        }
    }

    private Task EnsureWorkerAsync(BackendDefinition backend)
    {
        lock (_gate)
        {
            if (_worker is { HasExited: false })
                return Task.CompletedTask;
        }

        if (_consecutiveFailures >= MaxConsecutiveFailures)
            throw new InvalidOperationException("The Qwen3-TTS worker keeps exiting. " + TailOfLog());

        var startInfo = new ProcessStartInfo
        {
            FileName = backend.ExecutablePath!,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        startInfo.ArgumentList.Add(TtsBridgeScripts.EnsureWorker());
        startInfo.ArgumentList.Add("--model");
        startInfo.ArgumentList.Add(LlmTtsProcessRunner.ResolveModelPath(backend));
        if (LlmTtsProcessRunner.GetSoxDirectory() is { } soxDirectory)
        {
            var inheritedPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            startInfo.Environment["PATH"] = soxDirectory + Path.PathSeparator + inheritedPath;
        }

        var process = new Process { StartInfo = startInfo };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is not null)
                AppendLog(e.Data);
        };
        if (!process.Start())
            throw new InvalidOperationException("The Qwen3-TTS worker could not be started.");
        process.BeginErrorReadLine();
        lock (_gate)
        {
            _worker = process;
        }
        return Task.CompletedTask;
    }

    private void AppendLog(string line)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_logPath)!);
            File.AppendAllText(_logPath, line + Environment.NewLine);
        }
        catch
        {
            // Diagnostics must never break playback.
        }
    }

    private string TailOfLog()
    {
        try
        {
            if (!File.Exists(_logPath))
                return "No worker log was captured.";
            var lines = File.ReadAllLines(_logPath);
            return "Worker log tail: " + string.Join(" | ", lines.TakeLast(15));
        }
        catch
        {
            return "No worker log was captured.";
        }
    }

    public void Dispose()
    {
        Process? worker;
        lock (_gate)
        {
            worker = _worker;
            _worker = null;
        }
        if (worker is not null)
        {
            try
            {
                worker.StandardInput.WriteLine("quit");
                worker.StandardInput.Flush();
            }
            catch
            {
                // The worker is already gone.
            }
            if (!worker.WaitForExit(3000))
            {
                try { worker.Kill(entireProcessTree: true); }
                catch
                {
                    // Best effort.
                }
            }
            worker.Dispose();
        }
        _requestGate.Dispose();
    }

    private sealed record TtsWorkerRequest
    {
        [JsonPropertyName("id")]
        public long Id { get; set; }

        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;

        [JsonPropertyName("output")]
        public string Output { get; set; } = string.Empty;

        [JsonPropertyName("rate")]
        public double Rate { get; set; } = 1.0;

        [JsonPropertyName("speaker")]
        public string? Speaker { get; set; }

        [JsonPropertyName("language")]
        public string? Language { get; set; }

        [JsonPropertyName("instruct")]
        public string? Instruct { get; set; }

        [JsonPropertyName("ref_audio")]
        public string? RefAudio { get; set; }

        [JsonPropertyName("ref_text")]
        public string? RefText { get; set; }
    }

    private sealed record TtsWorkerResponse
    {
        [JsonPropertyName("ok")]
        public bool Ok { get; set; }

        [JsonPropertyName("id")]
        public long Id { get; set; }

        [JsonPropertyName("ms")]
        public long? Ms { get; set; }

        [JsonPropertyName("error")]
        public string? Error { get; set; }
    }
}
