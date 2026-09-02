using System;
using System.ComponentModel;
using System.Diagnostics;

namespace LlmServerManager.Models;

public class ServerScriptOption : INotifyPropertyChanged
{
    private bool _isRunning;
    private string _status = "Stopped";

    public ServerScriptOption(string title, string details, string badges, string scriptPath, string[] startArgs, int port)
    {
        Title = title;
        Details = details;
        Badges = badges;
        ScriptPath = scriptPath;
        StartArgs = startArgs;
        Port = port;
    }

    public string Title { get; }
    public string Details { get; }
    public string Badges { get; }
    public string ScriptPath { get; }
    public string[] StartArgs { get; }
    public int Port { get; }

    public Process? Process { get; set; }
    public DateTimeOffset? StartedAtUtc { get; set; }

    public bool IsRunning
    {
        get => _isRunning;
        set
        {
            if (_isRunning == value) return;
            _isRunning = value;
            OnPropertyChanged(nameof(IsRunning));
            OnPropertyChanged(nameof(IsStopped));
        }
    }

    public bool IsStopped => !_isRunning;

    public string Status
    {
        get => _status;
        set
        {
            if (_status == value) return;
            _status = value;
            OnPropertyChanged(nameof(Status));
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
