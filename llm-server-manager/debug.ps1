Write-Host "Starting with hot reload ..." -ForegroundColor Cyan
dotnet watch --project "$PSScriptRoot\LlmServerManager.csproj" --hot-reload
