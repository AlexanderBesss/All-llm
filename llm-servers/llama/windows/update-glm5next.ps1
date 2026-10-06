<#
.SYNOPSIS
    Update the glm5next-capable llama.cpp binaries (Unsloth build) used by GLM-5.3-Flash.
.DESCRIPTION
    Fetches the latest prebuilt release from unslothai/llama.cpp that contains the
    GLM-5-Next support (ggml-org PR #27754, merged into their 'mix' branch), downloads
    the Windows x64 (CUDA 13, portable) zip, extracts it, and overwrites conflicting
    files in llama/windows/glm5next.
    The official ggml-org builds do NOT load GLM-5.3-Flash: they fail with
    "unknown model architecture: 'glm5next'". Keep this folder separate from
    llama/windows/llama so update-llama.ps1 cannot overwrite it.
    Place this script inside llama/windows and run it.
    All output is also saved to update-glm5next.log beside this script.
#>

param([switch]$NonInteractive)

$LogFile = Join-Path $PSScriptRoot 'update-glm5next.log'
try { Start-Transcript -Path $LogFile -Append } catch {}

. (Join-Path $PSScriptRoot '../../scripts/update-github-release.ps1')

Update-GitHubRelease `
    -Title        'llama.cpp (Unsloth glm5next)' `
    -RepoOwner    'unslothai' `
    -RepoName     'llama.cpp' `
    -AssetPattern '^app-.*-windows-x64-cuda13-portable\.zip$' `
    -InstallDir   (Join-Path $PSScriptRoot 'glm5next') `
    -TempZip      (Join-Path $env:TEMP 'llama-update-glm5next.zip') `
    -TempDir      (Join-Path $env:TEMP "llama-update-glm5next-$(Get-Date -Format 'yyyyMMddHHmmss')") `
    -UserAgent    'llama-updater-pwsh' `
    -ReleaseChannel 'Latest' `
    -NonInteractive:$NonInteractive `
    -TestInstalled { param([string]$Path)
        (Test-Path (Join-Path $Path 'llama-server.exe')) -or
        (Test-Path (Join-Path $Path 'llama-cli.exe'))
    }
