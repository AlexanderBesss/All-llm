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
    public void SplitIntoChunks_HardCutsTextWithoutWhitespace()
    {
        var chunks = SpeechPlaybackService.SplitIntoChunks("abcdefghijk", 4);

        Assert.Equal(
            [("abcd", 0), ("efgh", 4), ("ijk", 8)],
            chunks.Select(chunk => (chunk.Text, chunk.Offset)).ToList());
    }

    [Fact]
    public void SplitIntoChunks_KeepsShortTextWholeAndDropsWhitespaceOnlyText()
    {
        Assert.Single(SpeechPlaybackService.SplitIntoChunks("hello", 500));
        Assert.Empty(SpeechPlaybackService.SplitIntoChunks("   \n\t  ", 500));
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
            var runner = new FakeLocalProcessRunner();
            var player = new FakeWavePlayer();
            using var service = new SpeechPlaybackService(piperRunner: runner, audioPlayer: player);
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
    public async Task Speak_WithChatterboxBackend_UsesLlmRunnerAndReportsCompletion()
    {
        var root = Path.Combine(Path.GetTempPath(), $"tts-reader-llm-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var executable = Path.Combine(root, "python.exe");
            File.WriteAllText(executable, "test");
            var llm = new FakeLocalProcessRunner();
            var player = new FakeWavePlayer();
            using var service = new SpeechPlaybackService(llmRunner: llm, audioPlayer: player);
            var ended = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            service.PlaybackEnded += (_, status) => ended.TrySetResult(status);
            var backend = new BackendDefinition
            {
                Id = "chatterbox", Name = "Chatterbox", Kind = "LLM", Engine = SpeechEngines.Chatterbox,
                ExecutablePath = executable, ModelPath = "ResembleAI/chatterbox", Variant = "base"
            };

            service.Speak("skip hello from chatterbox.", 5, backend, 1.0);
            var status = await ended.Task.WaitAsync(TimeSpan.FromSeconds(2));

            Assert.Equal("Playback finished.", status);
            Assert.Single(llm.Calls);
            Assert.Equal("hello from chatterbox.", llm.Calls[0].Text);
            Assert.Equal(1, player.PlayCount);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task Speak_WithLocalBackend_RaisesSynthesizingStatusAndPreparesOnce()
    {
        var root = Path.Combine(Path.GetTempPath(), $"tts-reader-status-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var executable = Path.Combine(root, "piper.exe");
            var model = Path.Combine(root, "voice.onnx");
            File.WriteAllText(executable, "test");
            File.WriteAllText(model, "test");
            File.WriteAllText(model + ".json", "{}");
            var runner = new FakeLocalProcessRunner();
            var player = new FakeWavePlayer();
            using var service = new SpeechPlaybackService(piperRunner: runner, audioPlayer: player);
            var statuses = new List<string>();
            var ended = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            service.PlaybackStatus += (_, status) => statuses.Add(status);
            service.PlaybackEnded += (_, status) => ended.TrySetResult(status);
            var backend = new BackendDefinition
            {
                Id = "piper", Name = "Piper", Kind = "Piper", Engine = SpeechEngines.Piper,
                ExecutablePath = executable, ModelPath = model
            };
            var text = string.Concat(Enumerable.Repeat(new string('a', 200) + ". ", 3));

            service.Speak(text, 0, backend, 1.0);
            await ended.Task.WaitAsync(TimeSpan.FromSeconds(2));

            Assert.True(runner.Calls.Count >= 2);
            Assert.Equal(1, runner.PrepareCalls);
            Assert.Equal(runner.Calls.Count, statuses.Count);
            Assert.StartsWith("Synthesizing chunk 1 of " + runner.Calls.Count, statuses[0]);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public void LlmCommand_BuildsBridgeArgumentsForChatterbox()
    {
        var backend = new BackendDefinition
        {
            Id = "chatterbox", Name = "Chatterbox", Kind = "LLM", Engine = SpeechEngines.Chatterbox,
            ExecutablePath = "C:\\TtsReader\\chatterbox\\Scripts\\python.exe",
            ModelPath = "ResembleAI/chatterbox", Variant = "base",
            Language = "English", VoiceName = "C:\\refs\\speaker.wav"
        };

        var info = LlmTtsProcessRunner.CreateStartInfo(
            backend, "text with spaces", "C:\\Out\\speech.wav", 1.2, "C:\\Scripts\\chatterbox_bridge.py");

        Assert.False(info.UseShellExecute);
        Assert.Equal(backend.ExecutablePath, info.FileName);
        Assert.Equal(
            ["C:\\Scripts\\chatterbox_bridge.py", "--model", "ResembleAI/chatterbox",
                "--output", "C:\\Out\\speech.wav", "--rate", "1.2", "--variant", "base",
                "--language", "English", "--ref-audio", "C:\\refs\\speaker.wav", "--", "text with spaces"],
            info.ArgumentList);
    }

    [Fact]
    public void LlmCommand_BuildsBridgeArgumentsForQwen3Clone()
    {
        var backend = new BackendDefinition
        {
            Id = "qwen", Name = "Qwen3-TTS", Kind = "LLM", Engine = SpeechEngines.Qwen3Tts,
            ExecutablePath = "C:\\TtsReader\\qwen3-tts\\Scripts\\python.exe",
            ModelPath = "Qwen/Qwen3-TTS-12Hz-0.6B-Voice",
            Variant = "voice-clone", VoiceName = "C:\\refs\\sample.wav",
            Instruct = "Reference transcript.", Language = "English"
        };

        var info = LlmTtsProcessRunner.CreateStartInfo(
            backend, "hello", "C:\\Out\\speech.wav", 1.0, "C:\\Scripts\\qwen3_tts_bridge.py");

        Assert.Equal(
            ["C:\\Scripts\\qwen3_tts_bridge.py", "--model", "Qwen/Qwen3-TTS-12Hz-0.6B-Voice",
                "--output", "C:\\Out\\speech.wav", "--rate", "1", "--ref-audio", "C:\\refs\\sample.wav",
                "--ref-text", "Reference transcript.", "--language", "English", "--", "hello"],
            info.ArgumentList);
    }

    [Fact]
    public void ChatterboxBridge_UsesUpstreamLoadersAndLanguageArgument()
    {
        var bridge = TtsBridgeScripts.ChatterboxBridge;

        Assert.Contains("from chatterbox.mtl_tts import ChatterboxMultilingualTTS", bridge);
        Assert.Contains("from chatterbox.tts_turbo import ChatterboxTurboTTS", bridge);
        Assert.Contains("ChatterboxTurboTTS.from_local", bridge);
        Assert.Contains("from chatterbox.tts import ChatterboxTTS", bridge);
        Assert.Contains("language_id", bridge);
        Assert.DoesNotContain("default_speaker.wav", bridge);
    }

    [Fact]
    public void QwenBridge_UsesKeywordArgumentsAndRequiresCloneTranscript()
    {
        var bridge = TtsBridgeScripts.Qwen3TtsBridge;

        Assert.Contains("if not args.ref_text:", bridge);
        Assert.Contains("text=text", bridge);
        Assert.Contains("language=args.language or \"Auto\"", bridge);
        Assert.Contains("ref_audio=args.ref_audio", bridge);
        Assert.Contains("ref_text=args.ref_text", bridge);
        Assert.Contains("speaker=args.speaker", bridge);
        Assert.Contains("instruct=args.instruct", bridge);
    }

    [Fact]
    public void QwenWorkerScript_IsValidJsonProtocolAndMaterializes()
    {
        var worker = TtsBridgeScripts.Qwen3TtsWorker;

        Assert.Contains("def emit(obj):", worker);
        Assert.Contains("sys.stdout.write(json.dumps(obj) + \"\\n\")", worker);
        Assert.Contains("qwen3 worker: ready device=", worker);
        Assert.Contains("if line == \"quit\":", worker);
        Assert.Contains("{\"ok\": False,", worker);
        Assert.Contains("sf.write(request[\"output\"], wav, sr)", worker);

        var path = TtsBridgeScripts.EnsureWorker();
        Assert.True(File.Exists(path));
        Assert.Equal(worker, File.ReadAllText(path));
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

    private sealed class FakeLocalProcessRunner : ILocalProcessSpeechRunner
    {
        public List<(string Text, double Rate)> Calls { get; } = [];
        public int PrepareCalls { get; private set; }
        public Task PrepareAsync(BackendDefinition backend, CancellationToken cancellationToken)
        {
            PrepareCalls++;
            return Task.CompletedTask;
        }
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
