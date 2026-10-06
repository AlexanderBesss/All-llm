<#
.SYNOPSIS
    Update llama.cpp CUDA 12.4 binaries for legacy NVIDIA GPUs (Maxwell, Pascal, Volta).
.DESCRIPTION
    The CUDA 13 release build is compiled without sm_50/sm_61/sm_70 - NVIDIA dropped
    those architectures in CUDA 13 - so a GTX 1080 (Ti) or Titan X aborts at startup with
    "no kernel image is available for execution on the device". The CUDA 12.4 release
    build still ships 61-virtual PTX, which the driver JIT-compiles for Pascal on first run.

    Two assets are needed and are installed side by side in llama/windows/cuda12:
      1. cudart-llama-bin-win-cuda-12.4-x64.zip  (cudart64_12, cublas64_12, cublasLt64_12)
      2. llama-<build>-bin-win-cuda-12.4-x64.zip (llama-server.exe and the ggml backends)
    The CUDA runtime is fetched first because only the second asset writes the
    VERSION-* marker that marks this backend as up to date.
.EXAMPLE
    .\update-cuda12.ps1                # update both assets
    .\update-cuda12.ps1 -Component cuda # only the llama.cpp binaries
#>

param(
    [ValidateSet('all', 'cudart', 'cuda')]
    [string]$Component = 'all',
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'

if ($Component -eq 'all') {
    # Update-GitHubRelease ends with `exit`, so each asset has to run in its own process.
    $host_ = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
    foreach ($part in 'cudart', 'cuda') {
        $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Component', $part)
        if ($NonInteractive) { $args += '-NonInteractive' }
        & $host_ @args
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    exit 0
}

$LogFile = Join-Path $PSScriptRoot 'update-cuda12.log'
try { Start-Transcript -Path $LogFile -Append } catch {}

. (Join-Path $PSScriptRoot '../../../scripts/update-github-release.ps1')

if ($Component -eq 'cudart') {
    Update-GitHubRelease `
        -Title        'llama.cpp (CUDA 12.4 runtime)' `
        -RepoOwner    'ggml-org' `
        -RepoName     'llama.cpp' `
        -AssetPattern '^cudart-llama-bin-win-cuda-12\.4-x64\.zip$' `
        -InstallDir   $PSScriptRoot `
        -TempZip      (Join-Path $env:TEMP 'llama-cuda12-cudart-latest.zip') `
        -TempDir      (Join-Path $env:TEMP "llama-cuda12-cudart-$(Get-Date -Format 'yyyyMMddHHmmss')") `
        -UserAgent    'llama-cuda12-cudart-updater-pwsh' `
        -ReleaseChannel 'Prerelease' `
        -NonInteractive:$NonInteractive `
        -TestInstalled { param([string]$Path)
            Test-Path (Join-Path $Path 'cudart64_12.dll')
        }
} else {
    Update-GitHubRelease `
        -Title        'llama.cpp (CUDA 12.4 / legacy NVIDIA)' `
        -RepoOwner    'ggml-org' `
        -RepoName     'llama.cpp' `
        -AssetPattern '^llama-.*-bin-win-cuda-12\.4-x64\.zip$' `
        -InstallDir   $PSScriptRoot `
        -TempZip      (Join-Path $env:TEMP 'llama-cuda12-latest.zip') `
        -TempDir      (Join-Path $env:TEMP "llama-cuda12-$(Get-Date -Format 'yyyyMMddHHmmss')") `
        -UserAgent    'llama-cuda12-updater-pwsh' `
        -ReleaseChannel 'Prerelease' `
        -NonInteractive:$NonInteractive `
        -TestInstalled { param([string]$Path)
            (Test-Path (Join-Path $Path 'llama-server.exe')) -or
            (Test-Path (Join-Path $Path 'llama-cli.exe'))
        }
}
