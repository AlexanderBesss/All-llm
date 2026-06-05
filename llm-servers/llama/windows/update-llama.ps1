<#
.SYNOPSIS
    Update llama.cpp binaries from the latest GitHub release.
.DESCRIPTION
    Fetches the latest release from ggml-org/llama.cpp, downloads the
    Windows x64 (CUDA 13) zip, extracts it, and overwrites conflicting
    files in llama/windows/llama.
    Place this script inside llama/windows and run it.
    All output is also saved to update-llama.log beside this script.
#>

$LogFile = Join-Path $PSScriptRoot 'update-llama.log'
try { Start-Transcript -Path $LogFile -Append } catch {}

. (Join-Path $PSScriptRoot '../../scripts/update-github-release.ps1')

Update-GitHubRelease `
    -Title        'llama.cpp' `
    -RepoOwner    'ggml-org' `
    -RepoName     'llama.cpp' `
    -AssetPattern '^llama-.*-bin-win-cuda-13.*-x64\.zip$' `
    -InstallDir   (Join-Path $PSScriptRoot 'llama') `
    -TempZip      (Join-Path $env:TEMP 'llama-update-latest.zip') `
    -TempDir      (Join-Path $env:TEMP "llama-update-$(Get-Date -Format 'yyyyMMddHHmmss')") `
    -UserAgent    'llama-updater-pwsh' `
    -TestInstalled { param([string]$Path)
        (Test-Path (Join-Path $Path 'llama-server.exe')) -or
        (Test-Path (Join-Path $Path 'llama-cli.exe')) -or
        (Test-Path (Join-Path $Path 'main.exe'))
    }
