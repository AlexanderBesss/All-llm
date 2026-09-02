using System;
using System.Collections.ObjectModel;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Windows.Threading;
using LlmServerManager.Models;
using LlmServerManager.Services;

namespace LlmServerManager.ViewModels;

public class MainViewModel : INotifyPropertyChanged
{
    private static readonly TimeSpan StartingGrace = TimeSpan.FromSeconds(120);

    private readonly DispatcherTimer _timer;
    private readonly System.Collections.Generic.Dictionary<int, bool> _portCache = new();

    private string _repoPath = "";
    private string _statusMessage = "Loading...";
    private bool _isRepoMissing;

    public MainViewModel()
    {
        StartCommand = new RelayCommand<ServerScriptOption>(StartOption, option => option is { IsRunning: false });
        StopCommand = new RelayCommand<ServerScriptOption>(StopOption, option => option is { IsRunning: true });
        UpdateCommand = new RelayCommand<UpdateAction>(RunUpdate, update => update is { IsRunning: false });
        RefreshCommand = new RelayCommand(Refresh);
        BrowseCommand = new RelayCommand(Browse);

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _timer.Tick += (_, _) => RefreshStatus();
        _timer.Start();

        Refresh();
    }

    public ObservableCollection<ServerScriptOption> BeellamaOptions { get; } = new();
    public ObservableCollection<ServerScriptOption> LlamaOptions { get; } = new();
    public ObservableCollection<UpdateAction> BeellamaUpdates { get; } = new();
    public ObservableCollection<UpdateAction> LlamaUpdates { get; } = new();

    public RelayCommand<ServerScriptOption> StartCommand { get; }
    public RelayCommand<ServerScriptOption> StopCommand { get; }
    public RelayCommand<UpdateAction> UpdateCommand { get; }
    public RelayCommand RefreshCommand { get; }
    public RelayCommand BrowseCommand { get; }

    public string RepoPath
    {
        get => _repoPath;
        private set { _repoPath = value; OnPropertyChanged(nameof(RepoPath)); }
    }

    public string StatusMessage
    {
        get => _statusMessage;
        private set { _statusMessage = value; OnPropertyChanged(nameof(StatusMessage)); }
    }

    public bool IsRepoMissing
    {
        get => _isRepoMissing;
        private set { _isRepoMissing = value; OnPropertyChanged(nameof(IsRepoMissing)); }
    }

    private void Refresh()
    {
        var repo = LocateRepo();
        if (repo == null)
        {
            IsRepoMissing = true;
            RepoPath = "";
            StatusMessage = "Repository not found. Run the app from inside the All-llm repo, or pick the folder that contains llm-servers.";
            return;
        }

        IsRepoMissing = false;
        RepoPath = repo;

        var tabs = ScriptScanner.GetTabs(repo);
        ReconcileOptions(BeellamaOptions, ScriptScanner.ScanTab(tabs[0]));
        ReconcileOptions(LlamaOptions, ScriptScanner.ScanTab(tabs[1]));
        ReconcileUpdates(BeellamaUpdates, tabs[0].Updates);
        ReconcileUpdates(LlamaUpdates, tabs[1].Updates);

        StatusMessage = $"Loaded {BeellamaOptions.Count} beellama and {LlamaOptions.Count} llama.cpp options from {repo}";
    }

    private static void ReconcileOptions(
        ObservableCollection<ServerScriptOption> current,
        IEnumerable<ServerScriptOption> scanned)
    {
        var existing = current.ToDictionary(OptionKey, StringComparer.OrdinalIgnoreCase);
        var next = new List<ServerScriptOption>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var option in scanned)
        {
            var key = OptionKey(option);
            seen.Add(key);
            if (existing.TryGetValue(key, out var previous))
            {
                option.Process = previous.Process;
                option.StartedAtUtc = previous.StartedAtUtc;
                option.IsRunning = previous.IsRunning;
                option.Status = previous.Status;
            }
            next.Add(option);
        }

        // Keep removed scripts visible until their active process can still be stopped.
        next.AddRange(current.Where(option => option.IsRunning && !seen.Contains(OptionKey(option))));

        current.Clear();
        foreach (var option in next)
            current.Add(option);
    }

    private static void ReconcileUpdates(
        ObservableCollection<UpdateAction> current,
        IEnumerable<UpdateDef> scanned)
    {
        var existing = current.ToDictionary(update => update.ScriptPath, StringComparer.OrdinalIgnoreCase);
        var next = new List<UpdateAction>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var definition in scanned)
        {
            seen.Add(definition.Path);
            var update = new UpdateAction(definition.Name, definition.Path);
            if (existing.TryGetValue(definition.Path, out var previous))
            {
                update.Process = previous.Process;
                update.IsRunning = previous.IsRunning;
                update.Status = previous.Status;
            }
            next.Add(update);
        }

        next.AddRange(current.Where(update => update.IsRunning && !seen.Contains(update.ScriptPath)));

        current.Clear();
        foreach (var update in next)
            current.Add(update);
    }

    private static string OptionKey(ServerScriptOption option) =>
        option.ScriptPath + "|" + string.Join("\u001f", option.StartArgs);

    private string? LocateRepo()
    {
        var overridePath = RepoLocator.LoadSettingsOverride();
        if (overridePath != null && Directory.Exists(Path.Combine(overridePath, "llm-servers")))
            return Path.GetFullPath(overridePath);

        return RepoLocator.FindFrom(AppContext.BaseDirectory);
    }

    private void Browse()
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "Select the All-llm repository root (the folder containing llm-servers)" };
        if (Directory.Exists(RepoPath))
            dialog.InitialDirectory = RepoPath;

        if (dialog.ShowDialog() == true)
        {
            RepoLocator.SaveSettingsOverride(dialog.FolderName);
            Refresh();
        }
    }

    private void StartOption(ServerScriptOption? option)
    {
        if (option == null || option.IsRunning)
            return;

        if (option.Port > 0 && PortProbe.IsListening(option.Port))
            StatusMessage = $"Port {option.Port} is already in use — {option.Title} may fail to bind. Starting anyway.";

        try
        {
            option.Process = ProcessRunner.StartScript(option.ScriptPath, option.StartArgs);
            option.StartedAtUtc = DateTimeOffset.UtcNow;
            option.IsRunning = true;
            option.Status = "Starting...";
            StatusMessage = $"Started {option.Title} — console window opened for logs.";
        }
        catch (Exception ex)
        {
            StatusMessage = $"Failed to start {option.Title}: {ex.Message}";
        }
    }

    private void StopOption(ServerScriptOption? option)
    {
        if (option == null || option.Process == null)
            return;

        try
        {
            ProcessRunner.StopTree(option.Process);
            option.IsRunning = false;
            option.StartedAtUtc = null;
            option.Status = "Stopped";
            StatusMessage = $"Stopped {option.Title}.";
        }
        catch (Exception ex)
        {
            StatusMessage = $"Failed to stop {option.Title}: {ex.Message}";
        }
    }

    private void RunUpdate(UpdateAction? update)
    {
        if (update == null || update.IsRunning)
            return;

        try
        {
            update.Process = ProcessRunner.StartScript(update.ScriptPath, Array.Empty<string>());
            update.IsRunning = true;
            update.Status = "Running";
            StatusMessage = $"Running {update.Name} — console window opened for logs.";
        }
        catch (Exception ex)
        {
            StatusMessage = $"Failed to run {update.Name}: {ex.Message}";
        }
    }

    private void RefreshStatus()
    {
        _portCache.Clear();

        foreach (var item in BeellamaOptions)
            RefreshOption(item);
        foreach (var item in LlamaOptions)
            RefreshOption(item);
        foreach (var item in BeellamaUpdates)
            RefreshUpdate(item);
        foreach (var item in LlamaUpdates)
            RefreshUpdate(item);
    }

    private void RefreshOption(ServerScriptOption item)
    {
        if (item.Process != null && item.Process.HasExited)
        {
            item.IsRunning = false;
            item.StartedAtUtc = null;
            item.Status = "Stopped";
            return;
        }

        if (!item.IsRunning)
            return;

        if (item.Port > 0 && PortListening(item.Port))
        {
            item.Status = "Running";
            return;
        }

        var elapsed = item.StartedAtUtc.HasValue ? DateTimeOffset.UtcNow - item.StartedAtUtc.Value : TimeSpan.Zero;
        item.Status = elapsed < StartingGrace ? "Starting..." : "Console open (port not listening)";
    }

    private void RefreshUpdate(UpdateAction item)
    {
        if (item.Process == null)
            return;

        if (item.Process.HasExited)
        {
            item.IsRunning = false;
            item.Status = "Done";
        }
        else
        {
            item.Status = "Running";
        }
    }

    private bool PortListening(int port)
    {
        if (_portCache.TryGetValue(port, out var cached))
            return cached;

        var result = PortProbe.IsListening(port);
        _portCache[port] = result;
        return result;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
