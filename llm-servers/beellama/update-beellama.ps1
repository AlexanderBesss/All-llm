<#
.SYNOPSIS
    Update beellama.cpp binaries from the latest GitHub release.
.DESCRIPTION
    Fetches the latest release from Anbeeld/beellama.cpp, downloads the
    Windows x64 (CUDA 13) zip, extracts it, and overwrites conflicting
    files in beellama/bin.
    Place this script inside beellama/ and run it.
    All output is also saved to update-beellama.log beside this script.
#>

$LogFile = Join-Path $PSScriptRoot 'update-beellama.log'
try { Start-Transcript -Path $LogFile -Append } catch {}

. (Join-Path $PSScriptRoot '../scripts/update-github-release.ps1')

Update-GitHubRelease `
    -Title        'beellama.cpp' `
    -RepoOwner    'Anbeeld' `
    -RepoName     'beellama.cpp' `
    -AssetPattern '^beellama-.*-bin-win-cuda-13.*-x64\.zip$' `
    -InstallDir   (Join-Path $PSScriptRoot 'bin') `
    -TempZip      (Join-Path $env:TEMP 'beellama-update-latest.zip') `
    -TempDir      (Join-Path $env:TEMP "beellama-update-$(Get-Date -Format 'yyyyMMddHHmmss')") `
    -UserAgent    'beellama-updater-pwsh' `
    -TestInstalled { param([string]$Path)
        (Test-Path (Join-Path $Path 'llama-server.exe')) -or
        (Test-Path (Join-Path $Path 'llama-cli.exe')) -or
        (Test-Path (Join-Path $Path 'main.exe'))
    }
