using TtsReader.Models;

namespace TtsReader.Services;

public interface IDocumentCatalog
{
    DocumentNode Build(string rootPath, CancellationToken cancellationToken = default);
}

public interface IDocumentTextExtractor
{
    Task<string> ReadAsync(string path, CancellationToken cancellationToken = default);
}

public interface ISettingsStore
{
    ReaderSettings Load();
    void Save(ReaderSettings settings);
    bool IsAvailable(BackendDefinition backend);
}

public interface ISpeechPlaybackService : IDisposable
{
    event EventHandler<string>? PlaybackEnded;
    event EventHandler<SpeechProgressEventArgs>? PlaybackProgress;
    event EventHandler<string>? PlaybackStatus;
    void Speak(string text, int caretIndex, BackendDefinition backend, double playbackRate);
    void Stop();
}

public sealed class SpeechProgressEventArgs(int characterIndex, int characterCount) : EventArgs
{
    public int CharacterIndex { get; } = characterIndex;
    public int CharacterCount { get; } = characterCount;
}
