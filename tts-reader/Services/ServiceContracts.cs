using TtsReader.Models;

namespace TtsReader.Services;

public interface IDocumentCatalog
{
    DocumentNode Build(string rootPath);
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
    string GetPackagePath(BackendDefinition backend);
}

public interface IBackendDownloader
{
    Task DownloadAsync(BackendDefinition backend, string destinationPath,
        IProgress<int>? progress = null, CancellationToken cancellationToken = default);
}

public interface ISpeechPlaybackService : IDisposable
{
    event EventHandler<string>? PlaybackEnded;
    event EventHandler<SpeechProgressEventArgs>? PlaybackProgress;
    void Speak(string text, int caretIndex, BackendDefinition backend, double playbackRate);
    void Stop();
}

public sealed class SpeechProgressEventArgs(int characterIndex, int characterCount) : EventArgs
{
    public int CharacterIndex { get; } = characterIndex;
    public int CharacterCount { get; } = characterCount;
}
