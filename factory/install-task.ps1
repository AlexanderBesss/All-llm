param(
    [Parameter(Mandatory = $true)][string]$RepoPath,
    [string]$ConfigPath = "",
    [string]$TaskName = "All-LLM Software Factory"
)

$resolvedRepo = (Resolve-Path -LiteralPath $RepoPath).Path
$cli = Join-Path $resolvedRepo "factory\dist\cli.js"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$arguments = "`"$cli`" start"
if ($ConfigPath) { $arguments += " --config `"$ConfigPath`"" }

$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $resolvedRepo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Continuously process opted-in Jira tickets through the local AI software factory." -Force | Out-Null
Write-Host "Installed scheduled task '$TaskName'."
