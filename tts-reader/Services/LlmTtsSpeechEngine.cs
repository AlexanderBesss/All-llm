using System.Diagnostics;
using System.Globalization;
using System.ComponentModel;
using TtsReader.Models;

namespace TtsReader.Services;

public static class LocalProcessTts
{
    public static async Task SynthesizeAsync(
        string engineLabel,
        ProcessStartInfo startInfo,
        string outputPath,
        CancellationToken cancellationToken)
    {
        using var process = new Process { StartInfo = startInfo };
        if (!process.Start())
            throw new InvalidOperationException($"{engineLabel} could not be started.");

        // Neural inference can use every available CPU core. Keep the desktop
        // UI and audio thread responsive while the next chunk is generated.
        try
        {
            process.PriorityClass = ProcessPriorityClass.BelowNormal;
        }
        catch (InvalidOperationException) { }
        catch (Win32Exception) { }

        var start = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            var error = await errorTask;
            WriteDiagnosticLog(engineLabel, startInfo, process.ExitCode, error, outputPath, start.Elapsed);
            if (process.ExitCode != 0)
                throw new InvalidOperationException($"{engineLabel} exited with code {process.ExitCode}: {error.Trim()}");
            if (!File.Exists(outputPath) || new FileInfo(outputPath).Length == 0)
                throw new InvalidDataException($"{engineLabel} did not produce a WAV file.");
        }
        catch (OperationCanceledException)
        {
            ProcessHelpers.TryKill(process);
            throw;
        }
    }

    private static void WriteDiagnosticLog(
        string engineLabel,
        ProcessStartInfo startInfo,
        int exitCode,
        string? error,
        string outputPath,
        TimeSpan elapsed)
    {
        try
        {
            var logRoot = TtsReaderPaths.LogsRoot;
            Directory.CreateDirectory(logRoot);
            var builder = new System.Text.StringBuilder();
            builder.AppendLine($"engine: {engineLabel}");
            builder.AppendLine($"process: {startInfo.FileName}");
            foreach (var argument in startInfo.ArgumentList)
                builder.AppendLine($"arg: {argument}");
            builder.AppendLine($"elapsed: {elapsed.TotalSeconds:0.0}s");
            builder.AppendLine($"exit code: {exitCode}");
            builder.AppendLine($"output wav: {(File.Exists(outputPath)
                ? $"{new FileInfo(outputPath).Length} bytes"
                : "missing")}");
            builder.AppendLine("stderr:");
            var stderr = error ?? string.Empty;
            if (stderr.Length > 20000)
                stderr = stderr[^20000..];
            builder.AppendLine(stderr);
            File.WriteAllText(Path.Combine(logRoot, $"tts-{DateTime.Now:yyyyMMdd-HHmmss-fff}.log"), builder.ToString());
            PruneOldLogs(logRoot);
        }
        catch
        {
            // Diagnostics must never break playback.
        }
    }

    private static void PruneOldLogs(string logRoot)
    {
        var files = Directory.EnumerateFiles(logRoot, "tts-*.log")
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .ToList();
        var cutoff = DateTime.UtcNow.AddDays(-7);
        var drop = files.Count > 30 ? 30 : int.MaxValue;
        foreach (var file in files.Where(path => File.GetLastWriteTimeUtc(path) < cutoff || files.IndexOf(path) >= drop))
        {
            try { File.Delete(file); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}

public sealed class LlmTtsProcessRunner : ILocalProcessSpeechRunner, IDisposable
{
    private static string? _soxDirectory;
    private static readonly object SoxDirectoryGate = new();
    private readonly QwenTtsWorkerRunner _qwenWorker = new();

    public async Task SynthesizeAsync(
        BackendDefinition backend,
        string text,
        string outputPath,
        double playbackRate,
        CancellationToken cancellationToken)
    {
        BackendValidation.ThrowIfNotConfigured(backend);
        if (backend.Engine == SpeechEngines.Qwen3Tts)
        {
            await _qwenWorker.SynthesizeAsync(backend, text, outputPath, playbackRate, cancellationToken);
            return;
        }
        var startInfo = CreateStartInfo(backend, text, outputPath, playbackRate);
        await LocalProcessTts.SynthesizeAsync(
            SpeechEngines.DisplayName(backend.Engine), startInfo, outputPath, cancellationToken);
    }

    public async Task PrepareAsync(BackendDefinition backend, CancellationToken cancellationToken)
    {
        if (backend.Engine == SpeechEngines.Qwen3Tts)
        {
            await LlmRuntimeDependencies.EnsureSoxAsync(null, 0, 1, cancellationToken);
            await _qwenWorker.PrepareAsync(backend, cancellationToken);
            return;
        }
        TtsBridgeScripts.Ensure(backend);
    }

    public static string? GetSoxDirectory() => FindSoxDirectoryCached();

    public void Dispose() => _qwenWorker.Dispose();

    public static void Validate(BackendDefinition backend) =>
        BackendValidation.ThrowIfNotConfigured(backend);

    public static ProcessStartInfo CreateStartInfo(
        BackendDefinition backend,
        string text,
        string outputPath,
        double playbackRate,
        string? bridgeScriptPath = null)
    {
        if (backend.Engine is not (SpeechEngines.Chatterbox or SpeechEngines.Qwen3Tts))
            throw new ArgumentOutOfRangeException(nameof(backend), $"Unsupported LLM engine '{backend.Engine}'.");

        var startInfo = new ProcessStartInfo
        {
            FileName = backend.ExecutablePath,
            UseShellExecute = false,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        if (backend.Engine == SpeechEngines.Qwen3Tts && FindSoxDirectoryCached() is { } soxDirectory)
        {
            var inheritedPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            startInfo.Environment["PATH"] = soxDirectory + Path.PathSeparator + inheritedPath;
        }
        startInfo.ArgumentList.Add(bridgeScriptPath ?? TtsBridgeScripts.Ensure(backend));
        startInfo.ArgumentList.Add("--model");
        startInfo.ArgumentList.Add(ResolveModelPath(backend));
        startInfo.ArgumentList.Add("--output");
        startInfo.ArgumentList.Add(outputPath);
        startInfo.ArgumentList.Add("--rate");
        startInfo.ArgumentList.Add(playbackRate.ToString("0.####", CultureInfo.InvariantCulture));

        if (backend.Engine == SpeechEngines.Chatterbox)
        {
            var variant = string.IsNullOrWhiteSpace(backend.Variant) ? "base" : backend.Variant.Trim();
            startInfo.ArgumentList.Add("--variant");
            startInfo.ArgumentList.Add(variant);
            AddIfPresent(startInfo, "--language", backend.Language);
            AddIfPresent(startInfo, "--ref-audio", backend.VoiceName);
        }
        else if (SpeechEngines.IsQwenVoiceClone(backend))
        {
            AddIfPresent(startInfo, "--ref-audio", backend.VoiceName);
            AddIfPresent(startInfo, "--ref-text", backend.Instruct);
            AddIfPresent(startInfo, "--language", backend.Language);
        }
        else if (SpeechEngines.IsQwenVoiceDesign(backend))
        {
            AddIfPresent(startInfo, "--language", backend.Language);
            AddIfPresent(startInfo, "--instruct", backend.VoiceName);
        }
        else
        {
            AddIfPresent(startInfo, "--speaker", backend.VoiceName);
            AddIfPresent(startInfo, "--language", backend.Language);
            AddIfPresent(startInfo, "--instruct", backend.Instruct);
        }
        startInfo.ArgumentList.Add("--");
        startInfo.ArgumentList.Add(text);
        return startInfo;
    }

    public static string ResolveModelPath(BackendDefinition backend)
    {
        var model = backend.ModelPath?.Trim();
        if (string.IsNullOrWhiteSpace(model))
            throw new InvalidDataException("The LLM model is not configured.");
        if (backend.Engine != SpeechEngines.Chatterbox ||
            !string.Equals(model, "ResembleAI/chatterbox", StringComparison.OrdinalIgnoreCase))
            return model;

        var variant = SpeechEngines.NormalizeVariant(backend);
        return variant.Contains("turbo", StringComparison.Ordinal)
            ? "ResembleAI/chatterbox-turbo"
            : variant.Contains("nano", StringComparison.Ordinal)
                ? "ResembleAI/chatterbox-nano"
                : model;
    }

    private static string? FindSoxDirectoryCached()
    {
        lock (SoxDirectoryGate)
        {
            if (_soxDirectory is not null)
                return _soxDirectory;
            var directory = LlmRuntimeDependencies.FindSoxDirectory();
            if (directory is not null)
                _soxDirectory = directory;
            return directory;
        }
    }

    private static void AddIfPresent(ProcessStartInfo startInfo, string flag, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        startInfo.ArgumentList.Add(flag);
        startInfo.ArgumentList.Add(value.Trim());
    }
}

public static class TtsBridgeScripts
{
    private static readonly Dictionary<string, string> EnsuredPaths = new(StringComparer.Ordinal);
    private static readonly object EnsureGate = new();

    public static string ScriptsRoot => TtsReaderPaths.ScriptsRoot;

    public static string PathFor(BackendDefinition backend) =>
        backend.Engine == SpeechEngines.Chatterbox
            ? Path.Combine(ScriptsRoot, "chatterbox_bridge.py")
            : Path.Combine(ScriptsRoot, "qwen3_tts_bridge.py");

    public static string ContentFor(BackendDefinition backend) =>
        backend.Engine == SpeechEngines.Chatterbox ? ChatterboxBridge : Qwen3TtsBridge;

    public static string WorkerPath => Path.Combine(ScriptsRoot, "qwen3_tts_worker.py");

    public static string EnsureWorker()
    {
        lock (EnsureGate)
        {
            var path = WorkerPath;
            Directory.CreateDirectory(ScriptsRoot);
            if (!File.Exists(path) || !string.Equals(File.ReadAllText(path), Qwen3TtsWorker, StringComparison.Ordinal))
                File.WriteAllText(path, Qwen3TtsWorker);
            return path;
        }
    }

    public static string Ensure(BackendDefinition backend)
    {
        lock (EnsureGate)
        {
            var key = backend.Engine;
            if (EnsuredPaths.TryGetValue(key, out var cached))
                return cached;
            var path = PathFor(backend);
            Directory.CreateDirectory(ScriptsRoot);
            var content = ContentFor(backend);
            if (!File.Exists(path) || !string.Equals(File.ReadAllText(path), content, StringComparison.Ordinal))
                File.WriteAllText(path, content);
            EnsuredPaths[key] = path;
            return path;
        }
    }

    public const string ChatterboxBridge = """
import argparse
import sys
from pathlib import Path


def parse():
    parser = argparse.ArgumentParser(description="TtsReader Chatterbox bridge: text to WAV.")
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--rate", type=float, default=1.0)
    parser.add_argument("--variant", default="base")
    parser.add_argument("--language", default=None)
    parser.add_argument("--ref-audio", default=None)
    parser.add_argument("--cfg-weight", type=float, default=1.7)
    parser.add_argument("--exaggeration", type=float, default=1.0)
    parser.add_argument("--device", default=None)
    parser.add_argument("text", nargs="?")
    args, extras = parser.parse_known_args()
    pieces = [piece for piece in ([args.text] + extras) if piece]
    return args, "\n".join(pieces).strip()


def stretch(wav, rate, sr):
    import numpy as np
    import torch
    x = wav.detach().cpu().squeeze().float().numpy()
    n_out = max(1, int(round(len(x) / rate)))
    hop = max(64, int(round(0.010 * sr)))
    width = int(round(0.100 * sr))
    if width > len(x):
        width = max(hop, len(x))
    if width > n_out:
        width = max(1, n_out)
    window = np.hanning(width)
    out = np.zeros(n_out + width, dtype=np.float32)
    norm = np.zeros(n_out + width, dtype=np.float32)
    frames = int(np.ceil(n_out / hop))
    for k in range(frames):
        src = int(round(k * hop * rate))
        if src >= len(x):
            break
        seg = x[src:src + width]
        win = window[:len(seg)]
        start = k * hop
        out[start:start + len(seg)] += seg * win
        norm[start:start + len(seg)] += win * win
    safe = np.where(norm > 1e-8, norm, 1.0)
    return torch.from_numpy((out[:n_out] / safe).astype(np.float32, copy=False))


def resolve_checkpoint(model):
    checkpoint = Path(model)
    if checkpoint.exists():
        if not checkpoint.is_dir():
            raise ValueError(f"Chatterbox model path is not a directory: {model}")
        return checkpoint
    from huggingface_hub import snapshot_download
    return Path(snapshot_download(repo_id=model))


def load_model(model, variant, device):
    checkpoint = resolve_checkpoint(model)
    if "multilingual" in variant or "v3" in variant or "t3" in variant:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        t3_model = "v3" if ("v3" in variant or "t3" in variant) else None
        return ChatterboxMultilingualTTS.from_local(checkpoint, device, t3_model=t3_model)
    if "turbo" in variant or "nano" in variant:
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        return ChatterboxTurboTTS.from_local(
            checkpoint, device, nano="nano" in variant)
    from chatterbox.tts import ChatterboxTTS
    return ChatterboxTTS.from_local(checkpoint, device)


def main():
    args, text = parse()
    if not text:
        print("chatterbox bridge: no text provided", file=sys.stderr)
        return 2
    import torch
    if args.device is None:
        args.device = "cuda:0" if torch.cuda.is_available() else "cpu"

    variant = (args.variant or "base").lower()
    if "multilingual" in variant or "v3" in variant or "t3" in variant:
        model = load_model(args.model, variant, args.device)
        kwargs = {}
        if args.ref_audio:
            kwargs["audio_prompt_path"] = args.ref_audio
        kwargs["language_id"] = args.language or "en"
        wav = model.generate(text, **kwargs)
    elif "turbo" in variant:
        if not args.ref_audio:
            print("chatterbox Turbo bridge: a reference .wav is required", file=sys.stderr)
            return 2
        model = load_model(args.model, variant, args.device)
        wav = model.generate(text, audio_prompt_path=args.ref_audio)
    elif "nano" in variant:
        if not args.ref_audio:
            print("chatterbox Nano bridge: a reference .wav is required", file=sys.stderr)
            return 2
        model = load_model(args.model, variant, args.device)
        wav = model.generate(text, audio_prompt_path=args.ref_audio)
    else:
        model = load_model(args.model, variant, args.device)
        wav = model.generate(
            text,
            audio_prompt_path=args.ref_audio,
            cfg_weight=args.cfg_weight,
            exaggeration=args.exaggeration,
        )

    if args.rate > 0 and abs(args.rate - 1.0) >= 1e-3:
        wav = stretch(wav, args.rate, model.sr)
    import torchaudio as ta
    ta.save(args.output, wav, model.sr)
    print(f"chatterbox bridge: wrote {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
""";

    public const string Qwen3TtsBridge = """
import argparse
import sys


def parse():
    parser = argparse.ArgumentParser(description="TtsReader Qwen3-TTS bridge: text to WAV.")
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--rate", type=float, default=1.0)
    parser.add_argument("--speaker", default=None)
    parser.add_argument("--language", default=None)
    parser.add_argument("--instruct", default=None)
    parser.add_argument("--ref-audio", default=None)
    parser.add_argument("--ref-text", default=None)
    parser.add_argument("--device", default=None)
    parser.add_argument("text", nargs="?")
    args, extras = parser.parse_known_args()
    pieces = [piece for piece in ([args.text] + extras) if piece]
    return args, "\n".join(pieces).strip()


def stretch(x, rate, sr):
    import numpy as np
    x = np.asarray(x, dtype=np.float32).reshape(-1)
    n_out = max(1, int(round(len(x) / rate)))
    hop = max(64, int(round(0.010 * sr)))
    width = int(round(0.100 * sr))
    if width > len(x):
        width = max(hop, len(x))
    if width > n_out:
        width = max(1, n_out)
    window = np.hanning(width)
    out = np.zeros(n_out + width, dtype=np.float32)
    norm = np.zeros(n_out + width, dtype=np.float32)
    frames = int(np.ceil(n_out / hop))
    for k in range(frames):
        src = int(round(k * hop * rate))
        if src >= len(x):
            break
        seg = x[src:src + width]
        win = window[:len(seg)]
        start = k * hop
        out[start:start + len(seg)] += seg * win
        norm[start:start + len(seg)] += win * win
    safe = np.where(norm > 1e-8, norm, 1.0)
    return (out[:n_out] / safe).astype(np.float32, copy=False)


def load(model, device):
    import torch
    from qwen_tts import Qwen3TTSModel
    kwargs = {}
    if device.startswith("cuda"):
        kwargs["dtype"] = torch.bfloat16
    try:
        return Qwen3TTSModel.from_pretrained(model, device_map=device, **kwargs)
    except Exception:
        kwargs["dtype"] = torch.float32
        return Qwen3TTSModel.from_pretrained(model, device_map=device, **kwargs)


def main():
    args, text = parse()
    if not text:
        print("qwen3 bridge: no text provided", file=sys.stderr)
        return 2
    import torch
    if args.device is None:
        args.device = "cuda:0" if torch.cuda.is_available() else "cpu"
    if not (args.speaker or args.ref_audio or args.instruct):
        print("qwen3 bridge: provide --speaker (custom voice), --instruct (voice design), or --ref-audio (voice clone)", file=sys.stderr)
        return 2

    model = load(args.model, args.device)
    if args.ref_audio:
        if not args.ref_text:
            print("qwen3 bridge: voice clone requires the reference transcript", file=sys.stderr)
            return 2
        wavs, sr = model.generate_voice_clone(
            text=text,
            language=args.language or "Auto",
            ref_audio=args.ref_audio,
            ref_text=args.ref_text,
        )
    elif args.speaker:
        wavs, sr = model.generate_custom_voice(
            text=text,
            speaker=args.speaker,
            language=args.language or "English",
            instruct=args.instruct,
        )
    else:
        wavs, sr = model.generate_voice_design(
            text=text,
            instruct=args.instruct,
            language=args.language or "English",
        )

    wav = wavs[0]
    if args.rate > 0 and abs(args.rate - 1.0) >= 1e-3:
        wav = stretch(wav, args.rate, sr)
    import soundfile as sf
    sf.write(args.output, wav, sr)
    print(f"qwen3 bridge: wrote {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
""";

    public const string Qwen3TtsWorker = """
import argparse
import json
import sys
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def stretch(x, rate, sr):
    import numpy as np
    x = np.asarray(x, dtype=np.float32).reshape(-1)
    n_out = max(1, int(round(len(x) / rate)))
    hop = max(64, int(round(0.010 * sr)))
    width = int(round(0.100 * sr))
    if width > len(x):
        width = max(hop, len(x))
    if width > n_out:
        width = max(1, n_out)
    window = np.hanning(width)
    out = np.zeros(n_out + width, dtype=np.float32)
    norm = np.zeros(n_out + width, dtype=np.float32)
    frames = int(np.ceil(n_out / hop))
    for k in range(frames):
        src = int(round(k * hop * rate))
        if src >= len(x):
            break
        seg = x[src:src + width]
        win = window[:len(seg)]
        start = k * hop
        out[start:start + len(seg)] += seg * win
        norm[start:start + len(seg)] += win * win
    safe = np.where(norm > 1e-8, norm, 1.0)
    return (out[:n_out] / safe).astype(np.float32, copy=False)


def synthesize(model, request, device):
    text = request.get("text") or ""
    rate = float(request.get("rate") or 1.0)
    if request.get("ref_audio"):
        if not request.get("ref_text"):
            raise SystemExit("voice clone requires the reference transcript")
        wavs, sr = model.generate_voice_clone(
            text=text,
            language=request.get("language") or "Auto",
            ref_audio=request["ref_audio"],
            ref_text=request["ref_text"],
        )
    elif request.get("speaker"):
        wavs, sr = model.generate_custom_voice(
            text=text,
            speaker=request["speaker"],
            language=request.get("language") or "English",
            instruct=request.get("instruct") or None,
        )
    elif request.get("instruct"):
        wavs, sr = model.generate_voice_design(
            text=text,
            instruct=request["instruct"],
            language=request.get("language") or "English",
        )
    else:
        raise SystemExit("provide speaker (custom voice), instruct (voice design), or ref_audio (voice clone)")
    wav = wavs[0]
    if rate > 0 and abs(rate - 1.0) >= 1e-3:
        wav = stretch(wav, rate, sr)
    import soundfile as sf
    sf.write(request["output"], wav, sr)


def main():
    parser = argparse.ArgumentParser(description="TtsReader Qwen3-TTS resident worker: keeps the model warm and reads JSON requests on stdin.")
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    started = time.time()
    import torch
    from qwen_tts import Qwen3TTSModel
    device = args.device or ("cuda:0" if torch.cuda.is_available() else "cpu")
    kwargs = {}
    if device.startswith("cuda"):
        kwargs["dtype"] = torch.bfloat16
    try:
        model = Qwen3TTSModel.from_pretrained(args.model, device_map=device, **kwargs)
    except Exception:
        kwargs["dtype"] = torch.float32
        model = Qwen3TTSModel.from_pretrained(args.model, device_map=device, **kwargs)
    sys.stderr.write("qwen3 worker: ready device=" + device + " after " + str(round(time.time() - started, 1)) + "s\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line == "quit":
            break
        request_id = 0
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"ok": False, "id": None, "error": "bad request: " + str(exc)})
            continue
        request_id = request.get("id", 0)
        started = time.time()
        try:
            synthesize(model, request, device)
        except SystemExit as exc:
            emit({"ok": False, "id": request_id, "error": str(exc)})
            continue
        except Exception as exc:
            emit({"ok": False, "id": request_id, "error": type(exc).__name__ + ": " + str(exc)})
            continue
        emit({"ok": True, "id": request_id, "ms": int((time.time() - started) * 1000)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
""";
}
