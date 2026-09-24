<#
.SYNOPSIS
    Update llama.cpp Vulkan binaries for Intel iGPU from the latest GitHub preview release.
.DESCRIPTION
    Fetches the latest pre-release from ggml-org/llama.cpp that contains the
    requested binary asset, downloads the Windows x64 (Vulkan) zip, extracts it,
    and overwrites conflicting files in llama/windows/vulkan.
    Place this script inside llama/windows/vulkan and run it.
    All output is also saved to update-vulkan.log beside this script.
#>

$LogFile = Join-Path $PSScriptRoot 'update-vulkan.log'
try { Start-Transcript -Path $LogFile -Append } catch {}

. (Join-Path $PSScriptRoot '../../../scripts/update-github-release.ps1')

Update-GitHubRelease `
    -Title        'llama.cpp (Vulkan / iGPU)' `
    -RepoOwner    'ggml-org' `
    -RepoName     'llama.cpp' `
    -AssetPattern '^llama-.*-bin-win-vulkan.*-x64\.zip$' `
    -InstallDir   $PSScriptRoot `
    -TempZip      (Join-Path $env:TEMP 'llama-vulkan-latest.zip') `
    -TempDir      (Join-Path $env:TEMP "llama-vulkan-$(Get-Date -Format 'yyyyMMddHHmmss')") `
    -UserAgent    'llama-vulkan-updater-pwsh' `
    -ReleaseChannel 'Prerelease' `
    -TestInstalled { param([string]$Path)
        (Test-Path (Join-Path $Path 'llama-server.exe')) -or
        (Test-Path (Join-Path $Path 'llama-cli.exe'))
    }
