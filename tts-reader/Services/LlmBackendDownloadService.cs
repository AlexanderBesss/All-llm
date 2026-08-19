using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using TtsReader.Models;

namespace TtsReader.Services;

public sealed record LlmDownloadProgress(double Percent, string Status)
{
    private sealed class Noop : IProgress<LlmDownloadProgress>
    {
        public void Report(LlmDownloadProgress value) { }
    }

    public static readonly IProgress<LlmDownloadProgress> NoopProgress = new Noop();
}

public sealed class LlmBackendDownloader : ILlmBackendDownloader
{
    private const string PythonVersion = "3.11.9";
    private const string ModelDownloadScript = """
import sys
from huggingface_hub import snapshot_download
snapshot_download(repo_id=sys.argv[1])
""";

    public async Task DownloadAsync(
        BackendDefinition backend,
        IProgress<LlmDownloadProgress> progress,
        CancellationToken cancellationToken)
    {
        if (!SpeechEngines.IsLlmEngine(backend.Engine))
            throw new ArgumentOutOfRangeException(nameof(backend), "Only LLM backends can be downloaded.");

        var pythonPath = ResolvePythonPath(backend);
        backend.ExecutablePath = pythonPath;
        var venvRoot = GetVenvRoot(pythonPath)
            ?? throw new InvalidDataException("Configure the LLM Python executable as a venv Scripts\\python.exe path before downloading.");

        progress.Report(new LlmDownloadProgress(0, "Preparing the Python environment…"));
        if (!File.Exists(pythonPath))
        {
            var basePythonPath = await EnsurePythonRuntimeAsync(progress, cancellationToken);
            Directory.CreateDirectory(Path.GetDirectoryName(venvRoot)!);
            await CreateVirtualEnvironmentAsync(basePythonPath, venvRoot, progress, cancellationToken);
        }

        var pipStart = 20d;
        if (backend.Engine == SpeechEngines.Qwen3Tts)
        {
            await LlmRuntimeDependencies.EnsureSoxAsync(progress, 20, 25, cancellationToken);
            pipStart = 25;
        }

        progress.Report(new LlmDownloadProgress(pipStart, "Updating pip…"));
        await RunProcessAsync(
            pythonPath,
            ["-m", "pip", "install", "--upgrade", "pip"],
            pipStart,
            30,
            "Updating pip",
            progress,
            cancellationToken);

        progress.Report(new LlmDownloadProgress(30, $"Installing {SpeechEngines.DisplayName(backend.Engine)}…"));
        await RunProcessAsync(
            pythonPath,
            PackageArguments(backend),
            30,
            70,
            $"Installing {SpeechEngines.DisplayName(backend.Engine)}",
            progress,
            cancellationToken);

        var model = LlmTtsProcessRunner.ResolveModelPath(backend);
        if (IsRepositoryReference(model))
        {
            progress.Report(new LlmDownloadProgress(70, "Downloading model weights…"));
            await RunProcessAsync(
                pythonPath,
                ["-c", ModelDownloadScript, model],
                70,
                99,
                "Downloading model weights",
                progress,
                cancellationToken);
        }

        progress.Report(new LlmDownloadProgress(100, "Download complete."));
    }

    private static string ResolvePythonPath(BackendDefinition backend)
    {
        if (!string.IsNullOrWhiteSpace(backend.ExecutablePath))
            return backend.ExecutablePath.Trim();

        var environmentName = backend.Engine == SpeechEngines.Chatterbox ? "chatterbox" : "qwen3-tts";
        return TtsReaderPaths.VenvPythonPath(environmentName);
    }

    private static string? GetVenvRoot(string pythonPath)
    {
        var scriptsDirectory = Path.GetDirectoryName(pythonPath);
        if (string.IsNullOrWhiteSpace(scriptsDirectory) ||
            !string.Equals(Path.GetFileName(scriptsDirectory), "Scripts", StringComparison.OrdinalIgnoreCase))
            return null;
        return Directory.GetParent(scriptsDirectory)?.FullName;
    }

    private static async Task<string> EnsurePythonRuntimeAsync(
        IProgress<LlmDownloadProgress> progress,
        CancellationToken cancellationToken)
    {
        var bundledPythonPath = TtsReaderPaths.PythonRuntimePath;
        if (File.Exists(bundledPythonPath) && await CanRunPythonAsync(bundledPythonPath, cancellationToken))
        {
            progress.Report(new LlmDownloadProgress(15, "Using the app's Python runtime."));
            return bundledPythonPath;
        }

        var systemPythonPath = await FindPythonLauncherAsync(cancellationToken);
        if (systemPythonPath is not null)
        {
            progress.Report(new LlmDownloadProgress(15, "Using the existing Python runtime."));
            return systemPythonPath;
        }

        return await InstallBundledPythonAsync(progress, cancellationToken);
    }

    private static async Task<string> InstallBundledPythonAsync(
        IProgress<LlmDownloadProgress> progress,
        CancellationToken cancellationToken)
    {
        var runtimeRoot = TtsReaderPaths.PythonRuntimeRoot;
        var pythonPath = TtsReaderPaths.PythonRuntimePath;
        var installerPath = Path.Combine(TtsReaderPaths.DownloadsRoot, GetPythonInstallerFileName());

        Directory.CreateDirectory(TtsReaderPaths.DownloadsRoot);
        if (!File.Exists(installerPath))
        {
            await HttpFileDownloader.DownloadFileAsync(
                GetPythonInstallerUrl(),
                installerPath,
                0,
                10,
                "Downloading Python",
                progress,
                cancellationToken);
        }

        progress.Report(new LlmDownloadProgress(10, "Installing the private Python runtime…"));
        Directory.CreateDirectory(runtimeRoot);
        await RunPythonInstallerAsync(installerPath, runtimeRoot, progress, cancellationToken);

        if (!File.Exists(pythonPath))
            throw new InvalidOperationException("Python was installed but its interpreter could not be found.");

        HttpFileDownloader.TryDelete(installerPath);
        progress.Report(new LlmDownloadProgress(15, "Private Python runtime ready."));
        return pythonPath;
    }

    private static async Task CreateVirtualEnvironmentAsync(
        string pythonPath,
        string venvRoot,
        IProgress<LlmDownloadProgress> progress,
        CancellationToken cancellationToken)
    {
        var arguments = new[] { "-m", "venv", venvRoot };
        await RunProcessAsync(
            pythonPath,
            arguments,
            15,
            20,
            "Creating Python environment",
            progress,
            cancellationToken);
    }

    private static async Task<string?> FindPythonLauncherAsync(CancellationToken cancellationToken)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var py = Path.Combine(directory, "py.exe");
            if (File.Exists(py) && await CanRunPythonAsync(py, cancellationToken))
                return py;
        }

        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var python = Path.Combine(directory, "python.exe");
            if (File.Exists(python) && await CanRunPythonAsync(python, cancellationToken))
                return python;
        }

        return null;
    }

    private static async Task<bool> CanRunPythonAsync(string fileName, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        startInfo.ArgumentList.Add("-c");
        startInfo.ArgumentList.Add("import sys; print(sys.version_info[:2])");

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
                return false;
            await process.WaitForExitAsync(cancellationToken);
            return process.ExitCode == 0;
        }
        catch (OperationCanceledException)
        {
            ProcessHelpers.TryKill(process);
            throw;
        }
        catch (Exception) when (cancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(cancellationToken);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static async Task RunPythonInstallerAsync(
        string installerPath,
        string targetDirectory,
        IProgress<LlmDownloadProgress> progress,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = installerPath,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var argument in new[]
        {
            "/quiet",
            "InstallAllUsers=0",
            $"TargetDir={targetDirectory}",
            "PrependPath=0",
            "Include_launcher=0",
            "InstallLauncherAllUsers=0",
            "Include_pip=1",
            "Include_test=0",
            "Include_doc=0",
            "Include_tcltk=0",
            "Include_tools=1",
            "Shortcuts=0",
            "AssociateFiles=0",
            "SimpleInstall=0",
            "NoRestart=1"
        })
            startInfo.ArgumentList.Add(argument);

        using var process = new Process { StartInfo = startInfo };
        if (!process.Start())
            throw new InvalidOperationException("Could not start the Python installer.");

        try
        {
            await process.WaitForExitAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            ProcessHelpers.TryKill(process);
            throw;
        }

        if (process.ExitCode is not 0 and not 3010)
            throw new InvalidOperationException($"Python installation failed with exit code {process.ExitCode}.");

        progress.Report(new LlmDownloadProgress(15, "Private Python runtime installed."));
    }

    private static string GetPythonInstallerUrl() =>
        $"https://www.python.org/ftp/python/{PythonVersion}/{GetPythonInstallerFileName()}";

    private static string GetPythonInstallerFileName() =>
        RuntimeInformation.OSArchitecture switch
        {
            Architecture.X64 => $"python-{PythonVersion}-amd64.exe",
            Architecture.X86 => $"python-{PythonVersion}.exe",
            Architecture.Arm64 => $"python-{PythonVersion}-arm64.exe",
            _ => throw new PlatformNotSupportedException("This Windows architecture is not supported by the Python runtime downloader.")
        };

    private const string CudaIndexUrl = "https://download.pytorch.org/whl/cu130";

    private static IReadOnlyList<string> PackageArguments(BackendDefinition backend)
    {
        if (backend.Engine == SpeechEngines.Chatterbox)
            return ["-m", "pip", "install", "--upgrade", "chatterbox-tts"];

        var arguments = new List<string>
        {
            "-m", "pip", "install", "--upgrade", "transformers", "accelerate", "torch", "soundfile", "qwen-tts"
        };
        if (HasNvidiaGpu())
            arguments.AddRange(["--extra-index-url", CudaIndexUrl]);
        return arguments;
    }

    private static bool HasNvidiaGpu()
    {
        try
        {
            var startInfo = new ProcessStartInfo("nvidia-smi", "--version")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            using var process = Process.Start(startInfo);
            if (process is null)
                return false;
            string? output = process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            return process.WaitForExit(10000) && process.ExitCode == 0
                && output is not null
                && output.Contains("nvidia", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsRepositoryReference(string model) =>
        !Directory.Exists(model) &&
        !File.Exists(model) &&
        !Path.IsPathRooted(model) &&
        !model.Contains('\\');

    private static async Task RunProcessAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        double startPercent,
        double endPercent,
        string stage,
        IProgress<LlmDownloadProgress> progress,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (var argument in arguments)
            startInfo.ArgumentList.Add(argument);

        using var process = new Process { StartInfo = startInfo };
        if (!process.Start())
            throw new InvalidOperationException($"Could not start {stage}.");

        var diagnostics = new List<string>();
        var outputTask = DrainAsync(process.StandardOutput, stage, startPercent, endPercent, progress, diagnostics);
        var errorTask = DrainAsync(process.StandardError, stage, startPercent, endPercent, progress, diagnostics);
        try
        {
            await process.WaitForExitAsync(cancellationToken);
            await Task.WhenAll(outputTask, errorTask);
        }
        catch (OperationCanceledException)
        {
            ProcessHelpers.TryKill(process);
            try { await Task.WhenAll(outputTask, errorTask); } catch { }
            throw;
        }

        if (process.ExitCode != 0)
        {
            var detail = diagnostics.Count == 0 ? string.Empty : $": {diagnostics[^1]}";
            throw new InvalidOperationException($"{stage} failed with exit code {process.ExitCode}{detail}");
        }

        progress.Report(new LlmDownloadProgress(endPercent, $"{stage} complete."));
    }

    private static async Task DrainAsync(
        StreamReader reader,
        string stage,
        double startPercent,
        double endPercent,
        IProgress<LlmDownloadProgress> progress,
        List<string> diagnostics)
    {
        while (await reader.ReadLineAsync() is { } line)
        {
            var text = line.Trim();
            if (text.Length == 0)
                continue;
            lock (diagnostics)
                diagnostics.Add(text);
            var relativePercent = TryReadPercent(text);
            var percent = relativePercent.HasValue
                ? startPercent + (relativePercent.Value / 100d * (endPercent - startPercent))
                : Math.Min(endPercent - 1, startPercent + 1);
            progress.Report(new LlmDownloadProgress(percent, $"{stage}: {TrimStatus(text)}"));
        }
    }

    private static double? TryReadPercent(string text)
    {
        var percentIndex = text.IndexOf('%');
        if (percentIndex < 1)
            return null;
        var start = percentIndex - 1;
        while (start >= 0 && (char.IsDigit(text[start]) || text[start] == '.'))
            start--;
        return double.TryParse(
                text[(start + 1)..percentIndex],
                NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture,
                out var value)
            ? Math.Clamp(value, 0, 100)
            : null;
    }

    private static string TrimStatus(string text) =>
        text.Length <= 120 ? text : text[^120..];
}

public interface ILlmBackendDownloader
{
    Task DownloadAsync(
        BackendDefinition backend,
        IProgress<LlmDownloadProgress> progress,
        CancellationToken cancellationToken);
}
