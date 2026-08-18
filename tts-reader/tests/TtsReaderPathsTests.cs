using TtsReader.Services;

namespace TtsReader.Tests;

public sealed class TtsReaderPathsTests
{
    [Fact]
    public void CleanupStaleTempDirs_RemovesOnlyDirectoriesOlderThanTheCutoff()
    {
        var stale = Path.Combine(TtsReaderPaths.TempRoot, $"tts-test-stale-{Guid.NewGuid():N}");
        var fresh = Path.Combine(TtsReaderPaths.TempRoot, $"tts-test-fresh-{Guid.NewGuid():N}");
        Directory.CreateDirectory(stale);
        Directory.CreateDirectory(fresh);
        try
        {
            File.WriteAllText(Path.Combine(stale, "speech.wav"), "wave");
            Directory.SetLastWriteTimeUtc(stale, DateTime.UtcNow.AddHours(-2));

            TtsReaderPaths.CleanupStaleTempDirs(TimeSpan.FromHours(1));

            Assert.False(Directory.Exists(stale));
            Assert.True(Directory.Exists(fresh));
        }
        finally
        {
            foreach (var directory in new[] { stale, fresh })
            {
                if (Directory.Exists(directory))
                    Directory.Delete(directory, true);
            }
        }
    }
}
