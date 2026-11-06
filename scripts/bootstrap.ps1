param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDir = Join-Path $root '.runtime'
$logDir = Join-Path $root 'data\logs'
$logFile = Join-Path $logDir 'launcher.log'
[void][IO.Directory]::CreateDirectory($logDir)
[void][IO.Directory]::CreateDirectory($runtimeDir)
function Write-Log([string]$message) {
    Write-Host $message
    [IO.File]::AppendAllText($logFile, ('{0:u} {1}{2}' -f [DateTime]::Now, $message, [Environment]::NewLine), [Text.Encoding]::UTF8)
}
function Test-Node([string]$candidate) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $false }
    try {
        $major = & $candidate -p "process.versions.node.split('.')[0]" 2>$null
        return ($LASTEXITCODE -eq 0 -and [int]$major -ge 24 -and (Test-Path -LiteralPath (Join-Path (Split-Path $candidate) 'node_modules\npm\bin\npm-cli.js')))
    } catch { return $false }
}
$bootstrapLock = $null
try {
    $deadline = [DateTime]::UtcNow.AddMinutes(4)
    while ($null -eq $bootstrapLock) {
        try {
            $bootstrapLock = [IO.File]::Open((Join-Path $runtimeDir 'bootstrap.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Другой запуск ещё устанавливает зависимости. Повторите позже.' }
            Start-Sleep -Milliseconds 250
        }
    }
    Write-Log 'Кагэмиюра: подготовка запуска…'
    $nodePath = Join-Path $runtimeDir 'node\node.exe'
    if (-not (Test-Node $nodePath)) {
        $installed = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($env:KAGEMIYURA_FORCE_PORTABLE -ne '1' -and $installed -and (Test-Node $installed.Source)) {
            $nodePath = $installed.Source
        } else {
            $config = Get-Content -LiteralPath (Join-Path $root 'runtime.json') -Raw | ConvertFrom-Json
            $architecture = $env:PROCESSOR_ARCHITECTURE
            if ($env:PROCESSOR_ARCHITEW6432) { $architecture = $env:PROCESSOR_ARCHITEW6432 }
            if ($architecture -eq 'ARM64') { $arch = 'arm64' }
            elseif ($architecture -eq 'AMD64') { $arch = 'x64' }
            else { throw 'Нужна 64-разрядная Windows: x64 или ARM64.' }
            $archiveName = 'node-v{0}-win-{1}' -f $config.version, $arch
            $zipFile = Join-Path $runtimeDir ($archiveName + '.zip')
            $expected = $config.sha256.$arch
            if (-not $expected -or $expected.Length -ne 64) { throw 'Не задана контрольная сумма Node.js.' }
            $valid = (Test-Path -LiteralPath $zipFile) -and ((Get-FileHash -LiteralPath $zipFile -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expected)
            if (-not $valid) {
                Write-Log ('Загрузка переносного Node.js {0} ({1})…' -f $config.version, $arch)
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                $partial = $zipFile + '.part'
                # Windows PowerShell's OutFile path handling interprets brackets.
                # Stream through .NET file APIs so the portable path stays literal.
                $download = [Net.HttpWebRequest]::Create(('https://nodejs.org/dist/v{0}/{1}.zip' -f $config.version, $archiveName))
                $download.Timeout = 180000
                $download.ReadWriteTimeout = 180000
                $downloadResponse = $null
                $downloadSource = $null
                $downloadTarget = $null
                try {
                    $downloadResponse = $download.GetResponse()
                    $downloadSource = $downloadResponse.GetResponseStream()
                    $downloadTarget = [IO.File]::Create($partial)
                    $downloadSource.CopyTo($downloadTarget)
                } finally {
                    if ($downloadTarget) { $downloadTarget.Dispose() }
                    if ($downloadSource) { $downloadSource.Dispose() }
                    if ($downloadResponse) { $downloadResponse.Dispose() }
                }
                if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
                    [IO.File]::Delete($partial)
                    throw 'Контрольная сумма Node.js не совпала. Запуск остановлен; повторите загрузку.'
                }
                if (Test-Path -LiteralPath $zipFile) { [IO.File]::Delete($zipFile) }
                [IO.File]::Move($partial, $zipFile)
            }
            $staging = Join-Path $runtimeDir ('node-staging-' + [Guid]::NewGuid().ToString('N'))
            # .NET extraction treats square brackets and other path characters literally.
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory($zipFile, $staging)
            $unpacked = Join-Path $staging $archiveName
            if (-not (Test-Node (Join-Path $unpacked 'node.exe'))) { throw 'Переносной Node.js не запускается. Проверьте блокировку антивирусом.' }
            $destination = Join-Path $runtimeDir 'node'
            if (Test-Path -LiteralPath $destination) {
                [IO.Directory]::Move($destination, ($destination + '-previous-' + [Guid]::NewGuid().ToString('N')))
            }
            [IO.Directory]::Move($unpacked, $destination)
            [IO.Directory]::Delete($staging, $true)
        }
    }
    Write-Log ('Node.js: ' + (& $nodePath --version))
    $npmCli = Join-Path (Split-Path $nodePath) 'node_modules\npm\bin\npm-cli.js'
    $env:PATH = (Split-Path $nodePath) + [IO.Path]::PathSeparator + $env:PATH
    $lockHash = (Get-FileHash -LiteralPath (Join-Path $root 'package-lock.json') -Algorithm SHA256).Hash
    $dependencyStamp = $lockHash + ':' + (& $nodePath -p 'process.version + process.arch')
    $stampFile = Join-Path $runtimeDir 'dependencies.sha256'
    $previousStamp = ''
    if (Test-Path -LiteralPath $stampFile) { $previousStamp = [IO.File]::ReadAllText($stampFile) }
    $compilerPath = Join-Path $root 'node_modules\typescript\bin\tsc'
    if ($previousStamp -ne $dependencyStamp -or -not (Test-Path -LiteralPath $compilerPath)) {
        Write-Log 'Установка зависимостей из package-lock.json…'
        & $nodePath $npmCli ci --prefix $root --no-audit --no-fund --ignore-scripts --cache (Join-Path $runtimeDir 'npm-cache')
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить зависимости. Проверьте доступ к registry.npmjs.org и повторите запуск.' }
        [IO.File]::WriteAllText($stampFile, $dependencyStamp)
    }
    $bootstrapLock.Dispose()
    $bootstrapLock = $null
    if ($env:KAGEMIYURA_PREPARE_ONLY -eq '1') {
        & $nodePath (Join-Path $root 'scripts\build.mjs')
    } else {
        & $nodePath (Join-Path $root 'scripts\launch.mjs')
    }
    if ($LASTEXITCODE -ne 0) { throw ('Приложение завершилось с кодом ' + $LASTEXITCODE) }
    exit 0
} catch {
    if ($null -ne $bootstrapLock) { $bootstrapLock.Dispose() }
    Write-Log ('Ошибка: ' + $_.Exception.Message)
    Write-Log ('Строка подготовки: ' + $_.InvocationInfo.ScriptLineNumber)
    Write-Host 'Журнал: data\logs\launcher.log' -ForegroundColor Yellow
    exit 1
}
