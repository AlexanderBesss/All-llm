using System.Diagnostics;
using System.Media;
using TtsReader.Models;

namespace TtsReader.Services;

public interface ILocalProcessSpeechRunner
{
    /// <summary>
    /// Runs once per playback start (not per chunk) so slow dependency setup
    /// never repeats for every synthesized chunk.
    /// </summary>
    Task PrepareAsync(BackendDefinition backend, CancellationToken cancellationToken);
    Task SynthesizeAsync(BackendDefinition backend, string text, string outputPath, double playbackRate, CancellationToken cancellationToken);
}

public interface IWaveAudioPlayer
{
    Task PlayAsync(string path, CancellationToken cancellationToken);
    void Stop();
}

public sealed class PiperProcessRunner : ILocalProcessSpeechRunner
{
    public Task PrepareAsync(BackendDefinition backend, CancellationToken cancellationToken) =>
        Task.CompletedTask;

    public async Task SynthesizeAsync(BackendDefinition backend, string text, string outputPath,
        double playbackRate, CancellationToken cancellationToken)
    {
        Validate(backend);
        var startInfo = CreateStartInfo(backend, text, outputPath, playbackRate);
        await LocalProcessTts.SynthesizeAsync("Piper", startInfo, outputPath, cancellationToken);
    }

    public static ProcessStartInfo CreateStartInfo(BackendDefinition backend, string text, string outputPath,
        double playbackRate)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = backend.ExecutablePath!,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true
        };
        startInfo.ArgumentList.Add("--model");
        startInfo.ArgumentList.Add(backend.ModelPath!);
        startInfo.ArgumentList.Add("--output-file");
        startInfo.ArgumentList.Add(outputPath);
        startInfo.ArgumentList.Add("--length-scale");
        startInfo.ArgumentList.Add((1.0 / playbackRate).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        startInfo.ArgumentList.Add("--");
        startInfo.ArgumentList.Add(text);
        return startInfo;
    }

    public static void Validate(BackendDefinition backend) =>
        BackendValidation.ThrowIfNotConfigured(backend);
}

public sealed class WaveAudioPlayer : IWaveAudioPlayer
{
    private readonly object _gate = new();
    private SoundPlayer? _player;

    public Task PlayAsync(string path, CancellationToken cancellationToken) => Task.Run(() =>
    {
        using var player = new SoundPlayer(path);
        lock (_gate)
            _player = player;
        using var registration = cancellationToken.Register(player.Stop);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            player.PlaySync();
            cancellationToken.ThrowIfCancellationRequested();
        }
        finally
        {
            lock (_gate)
                if (ReferenceEquals(_player, player)) _player = null;
        }
    }, cancellationToken);

    public void Stop()
    {
        lock (_gate)
            _player?.Stop();
    }
}
