$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
foreach ($file in @('scripts\bootstrap.ps1', 'tests\windows-launcher.ps1')) {
    $tokens = $null
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file), [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw ($errors | Out-String) }
}
# Exercise Cyrillic, spaces, percent, exclamation, caret, ampersand, parentheses and brackets.
$testRoot = Join-Path $env:RUNNER_TEMP ('Кагэмиюра ! % ^ & (тест) [1]-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
foreach ($item in (Get-ChildItem -LiteralPath $root -Force)) {
    if ($item.Name -notin @('.git', 'node_modules', 'dist', '.runtime', 'data')) {
        Copy-Item -LiteralPath $item.FullName -Destination $testRoot -Recurse -Force
    }
}
# Windows PowerShell 5.1 rewrites quotes for native arguments; pass the exact
# cmd.exe command line through ProcessStartInfo to preserve metacharacter paths.
function Invoke-TestBat {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $env:ComSpec
    $info.Arguments = '/d /v:off /s /c ""%KAGEMIYURA_TEST_BAT%""'
    $info.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($info)
    try {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw ('BAT завершился с кодом ' + $process.ExitCode) }
    } finally { $process.Dispose() }
}
try {
    $env:KAGEMIYURA_TEST_BAT = Join-Path $testRoot 'Kagemiyura.bat'
    $env:KAGEMIYURA_FORCE_PORTABLE = '1'
    $env:KAGEMIYURA_PREPARE_ONLY = '1'
    $env:KAGEMIYURA_NO_PAUSE = '1'
    Invoke-TestBat
    foreach ($file in @('.runtime\node\node.exe', '.runtime\dependencies.sha256', 'dist\public\assets\app.js', 'dist\server\app.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $testRoot $file))) { throw ('Не создан файл: ' + $file) }
    }
    $stampFile = Join-Path $testRoot '.runtime\dependencies.sha256'
    $stampTime = [IO.File]::GetLastWriteTimeUtc($stampFile)
    Invoke-TestBat
    if ([IO.File]::GetLastWriteTimeUtc($stampFile) -ne $stampTime) { throw 'Повторный запуск переустановил неизменившиеся зависимости.' }
    Write-Host 'BAT проверен: переносной Node.js, SHA-256, зависимости, повторный запуск и сложный путь.'
} finally {
    foreach ($name in @('KAGEMIYURA_TEST_BAT', 'KAGEMIYURA_FORCE_PORTABLE', 'KAGEMIYURA_PREPARE_ONLY', 'KAGEMIYURA_NO_PAUSE')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    if (Test-Path -LiteralPath $testRoot) { [IO.Directory]::Delete($testRoot, $true) }
}
