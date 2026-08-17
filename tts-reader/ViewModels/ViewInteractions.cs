using TtsReader.Models;

namespace TtsReader.ViewModels;

public interface IMainViewInteractions
{
    string? ChooseFolder();
    ReaderSettings? EditSettings(ReaderSettings settings);
}

public sealed record RenderedDocument(string Text, string? SourcePath, bool IsMarkdown);
