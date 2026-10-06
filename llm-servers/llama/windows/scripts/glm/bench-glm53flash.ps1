param(
    [string]$Prompt = 'Explain in detail how a mixture-of-experts transformer routes tokens to experts. Cover routing, load balancing, and inference.',
    [int]$NPredict = 200,
    [double]$Temp = 0.7,
    [string]$ServerHost = '127.0.0.1',
    [int]$Port = 8080,
    [switch]$Fresh
)

# Bench a running GLM-5.3-Flash server and print prompt / generation t/s.
# The server must already be up (e.g. via start-glm53flash.ps1).
#
# Usage:
#   .\bench-glm53flash.ps1
#   .\bench-glm53flash.ps1 -Prompt 'What is 12*13?' -NPredict 32 -Temp 0.0

$base = "http://${ServerHost}:${Port}"

try {
    $health = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 5
} catch {
    Write-Host "ERROR: no server at $base (start it first)" -ForegroundColor Red
    pause
    exit 1
}
if ($health.status -ne 'ok') {
    Write-Host "ERROR: server at $base is not ready" -ForegroundColor Red
    pause
    exit 1
}

if ($Fresh) {
    # unique suffix defeats KV-cache reuse so the full prompt is evaluated
    $Prompt += " [bench $(Get-Date -Format 'HHmmss')]"
}

$body = @{
    prompt       = $Prompt
    n_predict    = $NPredict
    temperature  = $Temp
    top_p        = 0.95
    top_k        = 20
    cache_prompt = $false
    stream       = $false
} | ConvertTo-Json

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$resp = Invoke-RestMethod -Uri "$base/completion" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 900
$sw.Stop()

$pp = $resp.tokens_evaluated
$tg = $resp.tokens_predicted
$pps = if ($resp.timings.prompt_ms) { $pp / ($resp.timings.prompt_ms / 1000) } else { 0 }
$tgs = if ($resp.timings.predicted_ms) { $tg / ($resp.timings.predicted_ms / 1000) } else { 0 }

Write-Host ("wall {0:N1}s | prompt {1} tok / {2:N2}s = {3:N1} t/s | gen {4} tok / {5:N2}s = {6:N2} t/s | cached {7} | truncated {8}" -f `
    $sw.Elapsed.TotalSeconds, $pp, ($resp.timings.prompt_ms / 1000), $pps, $tg, ($resp.timings.predicted_ms / 1000), $tgs, $resp.tokens_cached, $resp.truncated)
pause
