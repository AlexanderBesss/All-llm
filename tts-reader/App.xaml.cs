using System.Windows;
using System.Windows.Threading;
using TtsReader.Services;

namespace TtsReader;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        // Reclaim temporary WAV directories left behind by earlier crashes.
        _ = Task.Run(() => TtsReaderPaths.CleanupStaleTempDirs(TimeSpan.FromHours(1)));
        base.OnStartup(e);
    }

    private static void OnDispatcherUnhandledException(
        object sender,
        DispatcherUnhandledExceptionEventArgs e)
    {
        MessageBox.Show(
            $"An unexpected error occurred:\n\n{e.Exception.Message}",
            "TTS Reader",
            MessageBoxButton.OK,
            MessageBoxImage.Warning);
        e.Handled = true;
    }
}
