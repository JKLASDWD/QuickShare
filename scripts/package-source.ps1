param([string]$OutputDirectory = 'release')
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$utf8 = New-Object Text.UTF8Encoding($false)

function Invoke-Git([string]$Arguments, [string]$InputText = '') {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = 'git'
    $info.Arguments = $Arguments
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = $true
    $info.StandardOutputEncoding = $utf8
    $process = [Diagnostics.Process]::Start($info)
    if ($InputText) {
        $inputBytes = $utf8.GetBytes($InputText)
        $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    }
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEnd()
    $errorText = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw $errorText }
    $process.Dispose()
    return $output
}

$files = @((Invoke-Git 'ls-files --cached --others --exclude-standard -z').Split([char]0) |
    Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $root $_) -PathType Leaf) } |
    Sort-Object -Unique)
$attributes = (Invoke-Git 'check-attr -z --stdin export-ignore' (($files -join [char]0) + [char]0)).Split([char]0)
$excluded = @{}
for ($i = 0; $i + 2 -lt $attributes.Length; $i += 3) {
    if ($attributes[$i + 2] -eq 'set') { $excluded[$attributes[$i]] = $true }
}
$files = @($files | Where-Object {
    -not $excluded.ContainsKey($_) -and
    $_ -match '^(README\.md|\.gitignore|\.gitattributes|\.github/|client/|deploy/|docs/|server/|scripts/)' -and
    $_ -notmatch '(^|/)(node_modules|dist|vendor|\.review-tmp|build|bin)(/|$)' -and
    $_ -notmatch '(^|/)config\.json$|(^|/)\.env($|\.)|\.(pem|key|p12|pfx|crt|cer|exe|dll|zip|rar|7z|log|bak|tmp)$|^deploy/(livekit\.local\.yaml|docker-compose\.override\.ya?ml|caddy/certs/|nginx/[^/]+\.conf$)|^client/assets/icon\.png$|^deploy/\.quickshare-deploy$'
})
# A template is public source, not a local .env file.
if (Test-Path -LiteralPath (Join-Path $root 'deploy/.env.example')) { $files += 'deploy/.env.example' }
$files = @($files | Sort-Object -Unique)
foreach ($required in @('client/package.json', 'client/package-lock.json', 'client/native/CMakeLists.txt', 'client/native/process-audio.cpp', 'deploy/install.sh', 'server/token-service/server.mjs')) {
    if ($files -notcontains $required) { throw "Required source missing: $required" }
}
$version = (Get-Content -LiteralPath (Join-Path $root 'client/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version' }
$destination = [IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
if (-not $destination.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must remain inside the repository' }
[IO.Directory]::CreateDirectory($destination) | Out-Null
$archivePath = Join-Path $destination "QuickShare-Source-$version.zip"
if (Test-Path -LiteralPath $archivePath) { $archivePath = Join-Path $destination ("QuickShare-Source-$version-" + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff') + '.zip') }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew)
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in $files) {
        $entry = $archive.CreateEntry("QuickShare-$version/$relative", [IO.Compression.CompressionLevel]::Optimal)
        $targetStream = $entry.Open()
        try {
            $source = Join-Path $root $relative
            # Bash commands must retain LF when the archive is made on Windows.
            if ($relative.EndsWith('.sh')) {
                $bytes = $utf8.GetBytes(([IO.File]::ReadAllText($source) -replace "`r`n", "`n"))
                $targetStream.Write($bytes, 0, $bytes.Length)
            } else {
                $sourceStream = [IO.File]::OpenRead($source)
                try { $sourceStream.CopyTo($targetStream) } finally { $sourceStream.Dispose() }
            }
        } finally { $targetStream.Dispose() }
    }
} finally { $archive.Dispose(); $stream.Dispose() }
Write-Output "Source archive: $archivePath"
Write-Output ("Files: {0}; size: {1:N1} KB" -f $files.Count, ((Get-Item -LiteralPath $archivePath).Length / 1KB))
