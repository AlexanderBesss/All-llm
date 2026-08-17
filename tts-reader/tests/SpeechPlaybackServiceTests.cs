using TtsReader.Services;

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
}
