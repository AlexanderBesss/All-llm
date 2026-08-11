<#
.SYNOPSIS
    Update llama.cpp OpenVINO binaries for Intel NPU from the latest GitHub release.
.DESCRIPTION
    Fetches the latest release from ggml-org/llama.cpp, downloads the
    Windows x64 (OpenVINO) zip, extracts it, and overwrites conflicting
    files in llama/windows/llama-ov.
    Place this script inside llama/windows/NPU and run it.
    All output is also saved to update-npu.log beside this script.
#>

$LogFile = Join-Path $PSScriptRoot 'update-npu.log'
try { Start-Transcript -Path $LogFile -Append } catch {}

. (Join-Path $PSScriptRoot '../../../scripts/update-github-release.ps1')

Update-GitHubRelease `
    -Title        'llama.cpp (OpenVINO / NPU)' `
    -RepoOwner    'ggml-org' `
    -RepoName     'llama.cpp' `
    -AssetPattern '^llama-.*-bin-win-openvino-.*-x64\.zip$' `
    -InstallDir   (Join-Path $PSScriptRoot 'llama-ov') `
    -TempZip      (Join-Path $env:TEMP 'llama-npu-latest.zip') `
    -TempDir      (Join-Path $env:TEMP "llama-npu-$(Get-Date -Format 'yyyyMMddHHmmss')") `
    -UserAgent    'llama-npu-updater-pwsh' `
    -TestInstalled { param([string]$Path)
        (Test-Path (Join-Path $Path 'llama-server.exe')) -or
        (Test-Path (Join-Path $Path 'llama-cli.exe'))
    }
