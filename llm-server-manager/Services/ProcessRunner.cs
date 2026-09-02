using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

namespace LlmServerManager.Services;

public static class ProcessRunner
{
    public static Process StartScript(string scriptPath, string[] args)
    {
        var extra = string.Join(' ', args.Select(Quote));
        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + scriptPath + "\"" + (extra.Length > 0 ? " " + extra : ""),
            WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(scriptPath))!,
            UseShellExecute = false,
            CreateNoWindow = false,
        };
        var process = Process.Start(psi);
        if (process == null)
            throw new InvalidOperationException("Failed to start powershell.exe for " + scriptPath);
        return process;
    }

    public static void StopTree(Process process)
    {
        if (process.HasExited)
            return;

        var taskkill = Path.Combine(Environment.SystemDirectory, "taskkill.exe");
        var psi = new ProcessStartInfo(taskkill, "/F /T /PID " + process.Id)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var killer = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start taskkill.exe.");
        var taskkillCompleted = killer.WaitForExit(5000);
        var taskkillSucceeded = taskkillCompleted && killer.ExitCode == 0;

        if (!taskkillCompleted)
        {
            try
            {
                killer.Kill();
            }
            catch
            {
                // The taskkill process may have exited after the timeout.
            }
        }

        if (!taskkillSucceeded && !process.HasExited)
        {
            process.Kill(entireProcessTree: true);
        }

        if (!process.HasExited && !process.WaitForExit(5000))
            throw new InvalidOperationException($"Process tree {process.Id} did not stop.");
    }

    private static string Quote(string value) => value.Contains(' ') ? "\"" + value + "\"" : value;
}
