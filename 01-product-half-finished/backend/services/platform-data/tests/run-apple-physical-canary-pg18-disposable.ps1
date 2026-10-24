$ErrorActionPreference = "Stop"

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
$intendedRoot = [IO.Path]::GetFullPath((Join-Path $repo ".runtime"))
$stamp = Get-Date -Format "yyyyMMddTHHmmssfff"
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $intendedRoot ("cycling-backend-disposable-" + $stamp)))
$expectedPrefix = $intendedRoot + [IO.Path]::DirectorySeparatorChar
if (-not $runtimeRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "DISPOSABLE_ROOT_OUTSIDE_RUNTIME"
}

$bin = Join-Path $repo ".runtime\postgresql-18.6\pgsql\bin"
$initdb = Join-Path $bin "initdb.exe"
$pgctl = Join-Path $bin "pg_ctl.exe"
$createdb = Join-Path $bin "createdb.exe"
$psql = Join-Path $bin "psql.exe"
$port = 55434
$data = Join-Path $runtimeRoot "data"
$log = Join-Path $runtimeRoot "postgres.log"
$pgctlOut = Join-Path $runtimeRoot "pgctl.stdout.log"
$pgctlErr = Join-Path $runtimeRoot "pgctl.stderr.log"
$started = $false

if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
  throw "DISPOSABLE_PORT_IN_USE_$port"
}

try {
  New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
  & $initdb -D $data --username=paios_cycling_disposable --auth=trust --encoding=UTF8 --no-locale | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "INITDB_FAILED_$LASTEXITCODE" }

  $pgctlArguments = @(
    "-D", ('"' + $data + '"'),
    "-l", ('"' + $log + '"'),
    "-o", ('"-p ' + $port + ' -h 127.0.0.1"'),
    "-w", "start"
  )
  $pgctlProcess = Start-Process -FilePath $pgctl -ArgumentList $pgctlArguments -PassThru `
    -WindowStyle Hidden -RedirectStandardOutput $pgctlOut -RedirectStandardError $pgctlErr
  Wait-Process -Id $pgctlProcess.Id
  $pgctlProcess.Refresh()
  if ($pgctlProcess.ExitCode -ne 0) { throw "PG_START_FAILED_$($pgctlProcess.ExitCode)" }
  $started = $true

  & $createdb -h 127.0.0.1 -p $port -U paios_cycling_disposable personal_ai_os | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "CREATEDB_FAILED_$LASTEXITCODE" }

  $migrations = @(
    "migrations\0001_idempotency_outbox.up.sql",
    "migrations\0002_realtime_authority.up.sql",
    "migrations\0003_memory_authority.up.sql",
    "migrations\0004_memory_append_only_lifecycle.up.sql",
    "migrations\0005_apple_physical_canary_binding.up.sql"
  )
  foreach ($relative in $migrations) {
    & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U paios_cycling_disposable -d personal_ai_os -f (Join-Path $repo $relative) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "MIGRATION_FAILED_$relative" }
  }

  & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U paios_cycling_disposable -d personal_ai_os -f (Join-Path $repo "migrations\0005_apple_physical_canary_binding.up.sql") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "MIGRATION_0005_RERUN_FAILED" }
  $first = & $psql -X -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U paios_cycling_disposable -d personal_ai_os -c "SELECT current_setting('server_version'), count(*) FILTER (WHERE table_schema='public'), (SELECT count(*) FROM apple_physical_canary_bindings), (SELECT count(*) FROM device_leases), to_regclass('public.apple_physical_canary_bindings')::text FROM information_schema.tables WHERE table_schema='public';"
  if ($LASTEXITCODE -ne 0) { throw "READBACK_0005_FAILED" }

  & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U paios_cycling_disposable -d personal_ai_os -f (Join-Path $repo "migrations\0005_apple_physical_canary_binding.down.sql") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "MIGRATION_0005_DOWN_FAILED" }
  $afterDown = & $psql -X -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U paios_cycling_disposable -d personal_ai_os -c "SELECT count(*) FILTER (WHERE table_schema='public'), COALESCE(to_regclass('public.apple_physical_canary_bindings')::text,'ABSENT') FROM information_schema.tables WHERE table_schema='public';"
  if ($LASTEXITCODE -ne 0) { throw "READBACK_DOWN_FAILED" }

  & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U paios_cycling_disposable -d personal_ai_os -f (Join-Path $repo "migrations\0005_apple_physical_canary_binding.up.sql") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "MIGRATION_0005_REPLAY_FAILED" }
  $final = & $psql -X -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U paios_cycling_disposable -d personal_ai_os -c "SELECT count(*) FILTER (WHERE table_schema='public'), (SELECT count(*) FROM apple_physical_canary_bindings), (SELECT count(*) FROM device_leases), to_regclass('public.apple_physical_canary_bindings')::text FROM information_schema.tables WHERE table_schema='public';"
  if ($LASTEXITCODE -ne 0) { throw "FINAL_READBACK_FAILED" }

  $hashes = $migrations | ForEach-Object {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repo $_)).Hash.ToLowerInvariant()
    "$_=$hash"
  }
  [pscustomobject]@{
    status = "PASS"
    port = $port
    first_readback = $first
    after_down = $afterDown
    final_readback = $final
    migration_sha256 = $hashes
  } | ConvertTo-Json -Depth 4
}
finally {
  if ($started) {
    & $pgctl -D $data -m fast -w stop | Out-Null
  }
  if (Test-Path -LiteralPath $runtimeRoot) {
    $resolved = [IO.Path]::GetFullPath($runtimeRoot)
    if (-not $resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "CLEANUP_ROOT_OUTSIDE_RUNTIME"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    throw "DISPOSABLE_LISTENER_REMAINS_$port"
  }
  if (Test-Path -LiteralPath $runtimeRoot) {
    throw "DISPOSABLE_ROOT_REMAINS"
  }
}
