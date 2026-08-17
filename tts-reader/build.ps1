param([ValidateSet('Debug', 'Release')][string]$Configuration = 'Release')

$ErrorActionPreference = 'Stop'
dotnet publish "$PSScriptRoot\TtsReader.csproj" -c $Configuration -o "$PSScriptRoot\publish"
