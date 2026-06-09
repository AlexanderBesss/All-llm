param(
    [ValidateSet('default', 'e2b')]
    [string]$Mode = 'default'
)

$commonModel = "..\..\..\models\lmstudio-community\gemma-4-12B-it-QAT-GGUF"

$commonArgs = @(
    (Join-Path $PSScriptRoot 'llama\llama-server.exe'),
    '-m', "$commonModel\gemma-4-12B-it-QAT-Q4_0.gguf",
    '--mmproj', "$commonModel\mmproj-gemma-4-12B-it-QAT-BF16.gguf",
    '--host', '0.0.0.0',
    '--cache-type-k', 'q4_0',
    '--cache-type-v', 'q4_0',
    '--flash-attn', 'on',
    '--no-mmap',
    '--jinja',
    '--top-p', '0.95',
    '--min-p', '0.05',
    '--repeat-penalty', '1.0',
    '--reasoning', 'off',
    '--metrics',
    '--slots',
    '--perf'
)

switch ($Mode) {
    'default' {
        $args = $commonArgs + @(
            '--port', '8080',
            '--gpu-layers', 'all',
            '--ctx-size', '32768',
            '--batch-size', '2048',
            '--ubatch-size', '1024',
            '--temp', '0.7'
        )
    }
    'e2b' {
        $args = $commonArgs + @(
            '--port', '8082',
            '--gpu-layers', '5',
            '--ctx-size', '4096',
            '--batch-size', '1024',
            '--ubatch-size', '256',
            '--temp', '0.1'
        )
    }
}

& @args
pause
