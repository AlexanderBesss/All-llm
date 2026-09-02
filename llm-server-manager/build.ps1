param([switch]$Kill)

$projectPath = $PSScriptRoot
$publishDir   = Join-Path $projectPath "publish"

function Stop-RunningApp {
    $processes = @(Get-Process -Name "LlmServerManager" -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) {
        return
    }

    if ($Kill) {
        Write-Host "Force-closing running LlmServerManager..." -ForegroundColor Yellow
        $processes | Stop-Process -Force -ErrorAction SilentlyContinue
        return
    }

    Write-Host "Closing running LlmServerManager..." -ForegroundColor Yellow
    foreach ($process in $processes) {
        if ($process.MainWindowHandle -ne 0) {
            [void]$process.CloseMainWindow()
        }
    }

    Start-Sleep -Seconds 3

    $remaining = @(Get-Process -Name "LlmServerManager" -ErrorAction SilentlyContinue)
    if ($remaining.Count -gt 0) {
        Write-Host "ERROR: LlmServerManager did not close cleanly. Re-run with -Kill to force-close it." -ForegroundColor Red
        exit 1
    }
}

Stop-RunningApp

if (Get-Process -Name "LlmServerManager" -ErrorAction SilentlyContinue) {
    Write-Host "ERROR: LlmServerManager is still running and could not be closed." -ForegroundColor Red
    exit 1
}

Write-Host "Publishing Release to $publishDir ..." -ForegroundColor Cyan
dotnet publish "$projectPath\LlmServerManager.csproj" `
    -c Release `
    -r win-x64 `
    -o $publishDir `
    /p:PublishSingleFile=true `
    /p:SelfContained=false `
    /p:ExcludeFromSingleFile=true

if ($LASTEXITCODE -eq 0) {
    Write-Host "Done. Run: $publishDir\LlmServerManager.exe" -ForegroundColor Green
}
