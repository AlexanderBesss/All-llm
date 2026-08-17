using TtsReader.Services;
using TtsReader.Models;

namespace TtsReader.Tests;

public sealed class SpeechPlaybackServiceTests
{
    [Theory]
    [InlineData(0, "Read from here", "Read from here")]
    [InlineData(5, "Read from here", "from here")]
    [InlineData(10, "0123456789tail", "tail")]
    public void GetTextFromCaret_ReturnsExactRemainingText(int caret, string text, string expected)
    {
        Assert.Equal(expected, SpeechPlaybackService.GetTextFromCaret(text, caret));
    }

    [Fact]
    public void GetTextFromCaret_RejectsCaretAtWhitespaceOnlyTail()
    {
        Assert.Throws<InvalidOperationException>(() => SpeechPlaybackService.GetTextFromCaret("spoken   ", 6));
    }

    [Theory]
    [InlineData(1.0, 0)]
    [InlineData(1.25, 2)]
    [InlineData(1.5, 4)]
    public void MapPlaybackRate_UsesSystemSpeechRateSteps(double multiplier, int expectedRate)
    {
        Assert.Equal(expectedRate, SpeechPlaybackService.MapPlaybackRate(multiplier));
    }

    [Fact]
    public void SplitIntoChunks_PreservesOffsetsAndBoundsCommandLength()
    {
        var text = "First sentence. Second sentence is somewhat longer. Third sentence.";

        var chunks = SpeechPlaybackService.SplitIntoChunks(text, 24);

        Assert.True(chunks.Count >= 3);
        Assert.All(chunks, chunk => Assert.InRange(chunk.Text.Length, 1, 24));
        Assert.All(chunks, chunk => Assert.Equal(chunk.Text, text.Substring(chunk.Offset, chunk.Text.Length)));
    }

    [Fact]
    public async Task Speak_WithPiperBackend_UsesNeuralRunnerAndReportsCompletion()
    {
        var root = Path.Combine(Path.GetTempPath(), $"tts-reader-piper-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var executable = Path.Combine(root, "piper.exe");
            var model = Path.Combine(root, "voice.onnx");
            File.WriteAllText(executable, "test");
            File.WriteAllText(model, "test");
            File.WriteAllText(model + ".json", "{}");
            var runner = new FakePiperRunner();
            var player = new FakeWavePlayer();
            using var service = new SpeechPlaybackService(runner, player);
            var ended = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            service.PlaybackEnded += (_, status) => ended.TrySetResult(status);
            var backend = new BackendDefinition
            {
                Id = "piper", Name = "Piper", Kind = "Piper", Engine = SpeechEngines.Piper,
                ExecutablePath = executable, ModelPath = model
            };

            service.Speak("skip Speak this locally.", 5, backend, 1.25);
            var status = await ended.Task.WaitAsync(TimeSpan.FromSeconds(2));

            Assert.Equal("Playback finished.", status);
            Assert.Single(runner.Calls);
            Assert.Equal("Speak this locally.", runner.Calls[0].Text);
            Assert.Equal(1.25, runner.Calls[0].Rate);
            Assert.Equal(1, player.PlayCount);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public void PiperCommand_UsesArgumentListWithoutShellAndMapsSpeedToLengthScale()
    {
        var backend = new BackendDefinition
        {
            Id = "piper", Name = "Piper", Kind = "Piper", Engine = SpeechEngines.Piper,
            ExecutablePath = "C:\\Piper Path\\piper.exe", ModelPath = "C:\\Voice Path\\voice.onnx"
        };

        var info = PiperProcessRunner.CreateStartInfo(backend, "text & more", "C:\\Output Path\\speech.wav", 1.25);

        Assert.False(info.UseShellExecute);
        Assert.Equal(backend.ExecutablePath, info.FileName);
        Assert.Equal(
            ["--model", backend.ModelPath, "--output-file", "C:\\Output Path\\speech.wav",
                "--length-scale", "0.8", "--", "text & more"], info.ArgumentList);
    }

    private sealed class FakePiperRunner : IPiperProcessRunner
    {
        public List<(string Text, double Rate)> Calls { get; } = [];
        public Task SynthesizeAsync(BackendDefinition backend, string text, string outputPath,
            double playbackRate, CancellationToken cancellationToken)
        {
            Calls.Add((text, playbackRate));
            File.WriteAllText(outputPath, "wave");
            return Task.CompletedTask;
        }
    }

    private sealed class FakeWavePlayer : IWaveAudioPlayer
    {
        public int PlayCount { get; private set; }
        public Task PlayAsync(string path, CancellationToken cancellationToken)
        {
            PlayCount++;
            return Task.CompletedTask;
        }
        public void Stop() { }
    }
}
