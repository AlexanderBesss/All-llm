using System.ComponentModel;
using System.Diagnostics;

namespace TtsReader.Services;

public static class ProcessHelpers
{
    public static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
        catch (Win32Exception) { }
    }
}
