# Builds the Chrome Web Store package: dist/d365-who-has-access-<version>.zip
# The release manifest drops the localhost host permissions kept for local testing.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'
$shipFiles = @('manifest.json', 'background.js', 'popup.html', 'popup.css', 'popup.js', 'icons')
$devOnlyHosts = @('http://localhost/*', 'http://localhost:*/*', 'http://127.0.0.1/*', 'http://127.0.0.1:*/*')

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($item in $shipFiles) {
    Copy-Item -Recurse -LiteralPath (Join-Path $root $item) -Destination $stage
}

$manifestPath = Join-Path $stage 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.host_permissions = @($manifest.host_permissions | Where-Object { $_ -notin $devOnlyHosts })
$json = $manifest | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding($false)))

$zip = Join-Path $dist ("d365-who-has-access-{0}.zip" -f $manifest.version)
if (Test-Path $zip) { Remove-Item -Force $zip }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
Remove-Item -Recurse -Force $stage

Write-Output "Built $zip"
Write-Output ("Host permissions: " + ($manifest.host_permissions -join ', '))
