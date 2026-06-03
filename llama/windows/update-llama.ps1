<#
.SYNOPSIS
    Update llama.cpp binaries from the latest GitHub release.
.DESCRIPTION
    Fetches the latest release from ggml-org/llama.cpp, downloads the
    Windows x64 (CUDA 13) zip, extracts it, and overwrites conflicting
    files in the current folder.
    Place this script inside your existing llama.cpp bin folder and run it.
    All output is also saved to update-llama.log in the same folder.
#>

$LogFile = Join-Path $PSScriptRoot 'update-llama.log'
try { Start-Transcript -Path $LogFile -Append } catch {}

Write-Host "=== llama.cpp Updater ===" -ForegroundColor Cyan
Write-Host "Log: $LogFile" -ForegroundColor Gray
Write-Host ""

$RepoOwner    = 'ggml-org'
$RepoName     = 'llama.cpp'
$AssetPattern = '^llama-.*-bin-win-cuda-13.*-x64\.zip$'

$ScriptDir = $PSScriptRoot
$TempZip   = Join-Path $env:TEMP 'llama-update-latest.zip'
$TempDir   = Join-Path $env:TEMP "llama-update-$(Get-Date -Format 'yyyyMMddHHmmss')"

$ErrorOccurred = $false

# ---------- STEP 1: Fetch latest release ----------
Write-Host '[1/5] Fetching latest release from GitHub...' -ForegroundColor Cyan

$ApiUrl  = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
$Headers = @{ 'User-Agent' = 'llama-updater-pwsh' }

try {
    $Release = Invoke-RestMethod -Uri $ApiUrl -Headers $Headers -ErrorAction Stop
} catch {
    Write-Host "ERROR: Failed to fetch release info: $_" -ForegroundColor Red
    $ErrorOccurred = $true
}

if ($ErrorOccurred) {
    Write-Host ""
    Stop-Transcript -ErrorAction SilentlyContinue
    Read-Host 'Press Enter to exit'
    exit
}

$TagName = $Release.tag_name
Write-Host "       Latest release: $TagName" -ForegroundColor Green

# ---------- CHECK: Already up to date? ----------
$CurrentVersionMarker = Join-Path $ScriptDir "VERSION-$TagName"
if (Test-Path $CurrentVersionMarker) {
    Write-Host ""
    Write-Host "Already on $TagName -- nothing to do." -ForegroundColor Yellow
    Write-Host ""
    Stop-Transcript -ErrorAction SilentlyContinue
    Read-Host 'Press Enter to exit'
    exit
}

# ---------- STEP 2: Find the right asset ----------
Write-Host '[2/5] Locating Windows x64 (CUDA 13) asset...' -ForegroundColor Cyan

$Asset = $Release.assets | Where-Object { $_.name -match $AssetPattern } | Select-Object -First 1
if (-not $Asset) {
    Write-Host "ERROR: No asset matching '$AssetPattern' found in release $TagName" -ForegroundColor Red
    Write-Host "Available assets:" -ForegroundColor Yellow
    $Release.assets | ForEach-Object { Write-Host "  - $($_.name)" -ForegroundColor Yellow }
    Write-Host ""
    Stop-Transcript -ErrorAction SilentlyContinue
    Read-Host 'Press Enter to exit'
    exit
}

$DownloadUrl = $Asset.browser_download_url
$ZipName     = $Asset.name
Write-Host "       Found: $ZipName" -ForegroundColor Green

# ---------- STEP 3: Download ----------
Write-Host "[3/5] Downloading ($([math]::Round($Asset.size / 1MB, 1)) MB)..." -ForegroundColor Cyan

try {
    if (Test-Path $TempZip) { Remove-Item $TempZip -Force }
    $null = curl.exe -sL -o $TempZip -H "User-Agent: llama-updater-pwsh" $DownloadUrl
    if (-not (Test-Path $TempZip)) { throw "curl.exe returned no file" }
    Write-Host '       Download complete.' -ForegroundColor Green
} catch {
    Write-Host "ERROR: Download failed: $_" -ForegroundColor Red
    Write-Host ""
    Stop-Transcript -ErrorAction SilentlyContinue
    Read-Host 'Press Enter to exit'
    exit
}

# ---------- STEP 4: Extract ----------
Write-Host '[4/5] Extracting to temp folder...' -ForegroundColor Cyan

try {
    if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $TempDir | Out-Null
    Expand-Archive -Path $TempZip -DestinationPath $TempDir -Force

    # Flatten: if the zip contains a top-level folder, move its contents up
    $ExtractedItems = Get-ChildItem $TempDir
    if ($ExtractedItems.Count -eq 1 -and $ExtractedItems[0].PSIsContainer) {
        $InnerFolder = $ExtractedItems[0].FullName
        Get-ChildItem $InnerFolder | Move-Item -Destination $TempDir -Force
        Remove-Item $InnerFolder -Force
        Write-Host "       Flattened inner folder." -ForegroundColor Gray
    }
} catch {
    Write-Host "ERROR: Extraction failed: $_" -ForegroundColor Red
    Write-Host ""
    Stop-Transcript -ErrorAction SilentlyContinue
    Read-Host 'Press Enter to exit'
    exit
}

# ---------- STEP 5: Merge files ----------
Write-Host '[5/5] Merging files into current folder...' -ForegroundColor Cyan

$SourceFiles = Get-ChildItem -Path $TempDir -File
$Replaced = 0
$Added    = 0
$Skipped  = 0

foreach ($File in $SourceFiles) {
    $Dest = Join-Path $ScriptDir $File.Name

    if (Test-Path $Dest) {
        $HashSrc = Get-FileHash $File.FullName -Algorithm MD5
        $HashDst = Get-FileHash $Dest         -Algorithm MD5
        if ($HashSrc.Hash -eq $HashDst.Hash) {
            $Skipped++
            continue
        }
        Copy-Item -Path $File.FullName -Destination $Dest -Force
        $Replaced++
        Write-Host "  [REPLACE] $($File.Name)" -ForegroundColor Yellow
    } else {
        Copy-Item -Path $File.FullName -Destination $Dest -Force
        $Added++
        Write-Host "  [NEW]     $($File.Name)" -ForegroundColor Green
    }
}

# Clean up temp files
Remove-Item $TempZip -Force -ErrorAction SilentlyContinue
Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue

# Write version marker file (clean up old markers first)
Get-ChildItem -Path $ScriptDir -Filter 'VERSION-*' -File | Remove-Item -Force
$VersionMarker = Join-Path $ScriptDir "VERSION-$TagName"
"$TagName" | Set-Content -Path $VersionMarker -NoNewline

Write-Host ''
Write-Host '=== Update Summary ===' -ForegroundColor Cyan
Write-Host "  Version marker : $VersionMarker" -ForegroundColor Cyan
Write-Host "  New version    : $TagName ($ZipName)"
Write-Host "  Files replaced : $Replaced" -ForegroundColor Yellow
Write-Host "  Files added    : $Added" -ForegroundColor Green
Write-Host "  Files skipped  : $Skipped (unchanged)" -ForegroundColor Gray
Write-Host ''
Write-Host 'Done!' -ForegroundColor Green

# ---------- ALWAYS PAUSE AT THE END ----------
Write-Host ''
Stop-Transcript -ErrorAction SilentlyContinue
Read-Host 'Press Enter to exit'
