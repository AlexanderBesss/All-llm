using System;
using System.ComponentModel;
using System.Diagnostics;

namespace LlmServerManager.Models;

public class UpdateAction : INotifyPropertyChanged
{
    private bool _isRunning;
    private string _status = "Idle";

    public UpdateAction(string name, string scriptPath)
    {
        Name = name;
        ScriptPath = scriptPath;
    }

    public string Name { get; }
    public string ScriptPath { get; }

    public Process? Process { get; set; }

    public bool IsRunning
    {
        get => _isRunning;
        set
        {
            if (_isRunning == value) return;
            _isRunning = value;
            OnPropertyChanged(nameof(IsRunning));
            OnPropertyChanged(nameof(IsIdle));
        }
    }

    public bool IsIdle => !_isRunning;

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
