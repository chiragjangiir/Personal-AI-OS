param(
    [ValidateSet('Run', 'Stop', 'Preflight', 'SelfTest')]
    [string]$Action = 'Run',
    [string]$ControlId,
    [ValidateSet('Full', 'LifecycleFixture', 'AgentReadinessFixture', 'NativeFaultFixture', 'TestHarness')]
    [string]$SelfTestMode = 'Full',
    [ValidateSet('None', 'ContainmentProbe', 'Stress503', 'FullSuite')]
    [string]$HarnessCase = 'None',
    [ValidateSet('startup', 'readiness', 'steady', 'exit-zero', 'exit-nonzero')]
    [string]$FixtureStage = 'steady',
    [ValidateSet('valid', '503', 'wrong-agent', 'wrong-worker-type', 'invalid-json', 'wrong-content-type', 'timeout', 'non-loopback')]
    [string]$FixtureAgentMode = 'valid',
    [ValidateSet('None', 'CreateProcessW', 'AssignProcessToJobObject', 'ResumeThread')]
    [string]$FixtureNativeFault = 'None',
    [ValidateRange(40000, 49999)]
    [int]$FixturePort = 45191
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:RunnerNative = $null

function Get-ProcessInput([string]$Name) {
    return [Environment]::GetEnvironmentVariable($Name, 'Process')
}

function Require-ProcessInput([string]$Name) {
    $value = Get-ProcessInput $Name
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Missing process-only input: $Name"
    }
    return $value
}

function Resolve-ExistingFile([string]$Path, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label must identify an existing file"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-ExistingDirectory([string]$Path, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Label must identify an existing directory"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function New-RandomCredential([int]$Bytes) {
    $buffer = New-Object byte[] $Bytes
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($buffer)
    } finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertTo-WindowsCommandLineArgument {
    param([AllowEmptyString()][string]$Argument)
    if ($null -eq $Argument) { throw 'Native argument cannot be null' }
    if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') { return $Argument }

    $builder = New-Object Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes += 1
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * ($backslashes * 2 + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Get-RunnerNative {
    if ($null -ne $script:RunnerNative) { return $script:RunnerNative }
    if ([IntPtr]::Size -ne 8) { throw 'RUNNER_REQUIRES_64_BIT_POWERSHELL' }

    $assemblyName = New-Object Reflection.AssemblyName(
        'PaiosRunnerNative_' + [Guid]::NewGuid().ToString('N')
    )
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
        $assemblyName,
        [Reflection.Emit.AssemblyBuilderAccess]::Run
    )
    $module = $assembly.DefineDynamicModule($assemblyName.Name)
    $typeBuilder = $module.DefineType(
        'PaiosRunner.Native',
        [Reflection.TypeAttributes]'Public,Sealed,Abstract'
    )
    $dllImportConstructor = [Runtime.InteropServices.DllImportAttribute].GetConstructor(@([string]))
    $dllImportFields = @(
        [Runtime.InteropServices.DllImportAttribute].GetField('EntryPoint'),
        [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'),
        [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),
        [Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling'),
        [Runtime.InteropServices.DllImportAttribute].GetField('CallingConvention'),
        [Runtime.InteropServices.DllImportAttribute].GetField('PreserveSig')
    )

    function Add-RunnerNativeMethod {
        param(
            [string]$Name,
            [Type]$ReturnType,
            [Type[]]$ParameterTypes,
            [Runtime.InteropServices.CharSet]$CharSet = [Runtime.InteropServices.CharSet]::None
        )
        $method = $typeBuilder.DefineMethod(
            $Name,
            [Reflection.MethodAttributes]'Public,Static,PinvokeImpl',
            $ReturnType,
            $ParameterTypes
        )
        $attribute = New-Object Reflection.Emit.CustomAttributeBuilder(
            $dllImportConstructor,
            @('kernel32.dll'),
            $dllImportFields,
            @(
                $Name,
                $CharSet,
                $true,
                $true,
                [Runtime.InteropServices.CallingConvention]::Winapi,
                $true
            )
        )
        $method.SetCustomAttribute($attribute)
        $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    }

    Add-RunnerNativeMethod 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [string]) `
        ([Runtime.InteropServices.CharSet]::Unicode)
    Add-RunnerNativeMethod 'SetInformationJobObject' ([bool]) `
        @([IntPtr], [int], [IntPtr], [uint32])
    Add-RunnerNativeMethod 'QueryInformationJobObject' ([bool]) `
        @([IntPtr], [int], [IntPtr], [uint32], [IntPtr])
    Add-RunnerNativeMethod 'SetHandleInformation' ([bool]) `
        @([IntPtr], [uint32], [uint32])
    Add-RunnerNativeMethod 'GetHandleInformation' ([bool]) @([IntPtr], [IntPtr])
    Add-RunnerNativeMethod 'CreateProcessW' ([bool]) @(
        [string],
        [Text.StringBuilder],
        [IntPtr],
        [IntPtr],
        [bool],
        [uint32],
        [IntPtr],
        [string],
        [IntPtr],
        [IntPtr]
    ) ([Runtime.InteropServices.CharSet]::Unicode)
    Add-RunnerNativeMethod 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
    Add-RunnerNativeMethod 'IsProcessInJob' ([bool]) @([IntPtr], [IntPtr], [IntPtr])
    Add-RunnerNativeMethod 'ResumeThread' ([uint32]) @([IntPtr])
    Add-RunnerNativeMethod 'TerminateProcess' ([bool]) @([IntPtr], [uint32])
    Add-RunnerNativeMethod 'WaitForSingleObject' ([uint32]) @([IntPtr], [uint32])
    Add-RunnerNativeMethod 'GetProcessTimes' ([bool]) `
        @([IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr])
    Add-RunnerNativeMethod 'QueryFullProcessImageNameW' ([bool]) `
        @([IntPtr], [uint32], [Text.StringBuilder], [IntPtr]) `
        ([Runtime.InteropServices.CharSet]::Unicode)
    Add-RunnerNativeMethod 'CloseHandle' ([bool]) @([IntPtr])

    $script:RunnerNative = $typeBuilder.CreateType()
    return $script:RunnerNative
}

function Throw-RunnerWin32([string]$Operation) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "$Operation failed (Win32=$code)"
}

function New-RunnerJob {
    $native = Get-RunnerNative
    $handle = $native::CreateJobObjectW([IntPtr]::Zero, $null)
    if ($handle -eq [IntPtr]::Zero) { Throw-RunnerWin32 'CreateJobObjectW' }
    $limit = [IntPtr]::Zero
    $flags = [IntPtr]::Zero
    try {
        # x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes; LimitFlags is at offset 16.
        $limit = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
        [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 144), 0, $limit, 144)
        [Runtime.InteropServices.Marshal]::WriteInt32($limit, 16, 0x2000)
        if (-not $native::SetInformationJobObject($handle, 9, $limit, 144)) {
            Throw-RunnerWin32 'SetInformationJobObject'
        }
        if (-not $native::SetHandleInformation($handle, 1, 0)) {
            Throw-RunnerWin32 'SetHandleInformation'
        }
        $flags = [Runtime.InteropServices.Marshal]::AllocHGlobal(4)
        [Runtime.InteropServices.Marshal]::WriteInt32($flags, 0)
        if (-not $native::GetHandleInformation($handle, $flags)) {
            Throw-RunnerWin32 'GetHandleInformation'
        }
        if (([Runtime.InteropServices.Marshal]::ReadInt32($flags) -band 1) -ne 0) {
            throw 'RUNNER_JOB_HANDLE_INHERITABLE'
        }
        return $handle
    } catch {
        [void]$native::CloseHandle($handle)
        throw
    } finally {
        if ($limit -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($limit)
        }
        if ($flags -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($flags)
        }
    }
}

function Get-RunnerJobActiveCount([IntPtr]$JobHandle) {
    $native = Get-RunnerNative
    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(48)
    try {
        [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 48), 0, $buffer, 48)
        if (-not $native::QueryInformationJobObject($JobHandle, 1, $buffer, 48, [IntPtr]::Zero)) {
            Throw-RunnerWin32 'QueryInformationJobObject'
        }
        return [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 40)
    } finally {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }
}

function Get-RunnerJobProcessIds([IntPtr]$JobHandle) {
    $native = Get-RunnerNative
    $capacity = 512
    $bufferSize = 8 + ([IntPtr]::Size * $capacity)
    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bufferSize)
    try {
        [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $bufferSize), 0, $buffer, $bufferSize)
        if (-not $native::QueryInformationJobObject($JobHandle, 3, $buffer, $bufferSize, [IntPtr]::Zero)) {
            Throw-RunnerWin32 'QueryInformationJobObject(ProcessIdList)'
        }
        $assigned = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 0)
        $listed = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 4)
        if ($assigned -gt $capacity -or $listed -gt $capacity -or $listed -gt $assigned) {
            throw 'RUNNER_JOB_PROCESS_LIST_OVERFLOW'
        }
        $ids = New-Object 'System.Collections.Generic.List[int]'
        for ($index = 0; $index -lt $listed; $index += 1) {
            $offset = 8 + ([IntPtr]::Size * $index)
            $processId = if ([IntPtr]::Size -eq 8) {
                [Runtime.InteropServices.Marshal]::ReadInt64($buffer, $offset)
            } else {
                [Runtime.InteropServices.Marshal]::ReadInt32($buffer, $offset)
            }
            if ($processId -gt 0 -and $processId -le [int]::MaxValue) {
                $ids.Add([int]$processId)
            }
        }
        return @($ids)
    } finally {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }
}

function Close-RunnerJob([IntPtr]$JobHandle) {
    if ($JobHandle -eq [IntPtr]::Zero) { return }
    $native = Get-RunnerNative
    if (-not $native::CloseHandle($JobHandle)) { Throw-RunnerWin32 'CloseHandle(job)' }
}

function New-ChildEnvironmentBlock {
    param(
        [hashtable]$Environment,
        [switch]$Minimal
    )
    $values = New-Object 'Collections.Generic.Dictionary[string,string]' `
        ([StringComparer]::OrdinalIgnoreCase)
    if ($Minimal) {
        foreach ($name in @(
            'SystemRoot',
            'WINDIR',
            'TEMP',
            'TMP',
            'ComSpec',
            'PATHEXT',
            'PROCESSOR_ARCHITECTURE',
            'NUMBER_OF_PROCESSORS'
        )) {
            $value = [Environment]::GetEnvironmentVariable($name, 'Process')
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                $values[$name] = $value
            }
        }
        $values['PATH'] = 'C:\Program Files\nodejs;C:\Windows\System32'
    } else {
        foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
            $values[[string]$entry.Key] = [string]$entry.Value
        }
    }
    foreach ($name in @(
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
        'LIVEKIT_KEYS',
        'LIVEKIT_ROOM_AUTO_CREATE',
        'PAIOS_RUNNER_CONTROL_ID',
        'PAIOS_GATEWAY_TEST_HARNESS',
        'G_A1_R5_1_503_STRESS'
    )) {
        [void]$values.Remove($name)
    }
    foreach ($entry in $Environment.GetEnumerator()) {
        $name = [string]$entry.Key
        $value = [string]$entry.Value
        if ([string]::IsNullOrWhiteSpace($name) -or $name.Contains('=') -or
            $name.Contains("`0") -or $value.Contains("`0")) {
            throw 'INVALID_CHILD_ENVIRONMENT_ENTRY'
        }
        $values[$name] = $value
    }
    $keys = New-Object string[] $values.Count
    $values.Keys.CopyTo($keys, 0)
    [Array]::Sort($keys, [StringComparer]::OrdinalIgnoreCase)
    $builder = New-Object Text.StringBuilder
    foreach ($name in $keys) {
        [void]$builder.Append($name).Append('=').Append($values[$name]).Append([char]0)
    }
    [void]$builder.Append([char]0)
    return [Runtime.InteropServices.Marshal]::StringToHGlobalUni($builder.ToString())
}

function New-OwnedProcessStartInfo {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [hashtable]$Environment
    )
    $resolvedFile = Resolve-ExistingFile $FilePath 'Owned executable'
    $resolvedWorkingDirectory = Resolve-ExistingDirectory $WorkingDirectory 'Owned working directory'
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $resolvedFile
    $info.WorkingDirectory = $resolvedWorkingDirectory
    $info.UseShellExecute = $false
    $encoded = @($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ })
    $info.Arguments = $encoded -join ' '
    foreach ($secretName in @('LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_KEYS')) {
        if ($info.EnvironmentVariables.ContainsKey($secretName)) {
            $info.EnvironmentVariables.Remove($secretName)
        }
    }
    foreach ($entry in $Environment.GetEnumerator()) {
        $info.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
    }
    return $info
}

function Start-OwnedProcess {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [hashtable]$Environment,
        [IntPtr]$JobHandle,
        [ValidateSet('None', 'CreateProcessW', 'AssignProcessToJobObject', 'ResumeThread')]
        [string]$FaultInjection = 'None',
        [switch]$MinimalEnvironment
    )
    if ($JobHandle -eq [IntPtr]::Zero) { throw 'RUNNER_JOB_REQUIRED' }
    $native = Get-RunnerNative
    $resolvedFile = Resolve-ExistingFile $FilePath 'Owned executable'
    $resolvedWorkingDirectory = Resolve-ExistingDirectory $WorkingDirectory 'Owned working directory'
    foreach ($argument in $Arguments) {
        if ($null -eq $argument -or $argument.Contains("`0")) { throw 'INVALID_NATIVE_ARGUMENT' }
    }
    $commandLine = (ConvertTo-WindowsCommandLineArgument $resolvedFile) + ' ' +
        (@($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join ' ')
    if ($commandLine.Length -ge 32767) { throw 'NATIVE_COMMAND_LINE_TOO_LONG' }

    $startupInfo = [IntPtr]::Zero
    $processInfo = [IntPtr]::Zero
    $environmentBlock = [IntPtr]::Zero
    $created = $false
    $assigned = $false
    $resumed = $false
    $processHandle = [IntPtr]::Zero
    $threadHandle = [IntPtr]::Zero
    $processId = 0
    try {
        $startupInfo = [Runtime.InteropServices.Marshal]::AllocHGlobal(104)
        $processInfo = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
        [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 104), 0, $startupInfo, 104)
        [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 24), 0, $processInfo, 24)
        [Runtime.InteropServices.Marshal]::WriteInt32($startupInfo, 0, 104)
        $environmentBlock = New-ChildEnvironmentBlock $Environment -Minimal:$MinimalEnvironment
        $mutableCommandLine = New-Object Text.StringBuilder($commandLine)
        if ($FaultInjection -eq 'CreateProcessW') {
            throw 'FAULT_INJECT_CREATEPROCESSW'
        }
        if (-not $native::CreateProcessW(
            $resolvedFile,
            $mutableCommandLine,
            [IntPtr]::Zero,
            [IntPtr]::Zero,
            $false,
            0x404,
            $environmentBlock,
            $resolvedWorkingDirectory,
            $startupInfo,
            $processInfo
        )) {
            Throw-RunnerWin32 'CreateProcessW'
        }
        $created = $true
        $processHandle = [Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, 0)
        $threadHandle = [Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, 8)
        $processId = [Runtime.InteropServices.Marshal]::ReadInt32($processInfo, 16)

        if ($FaultInjection -eq 'AssignProcessToJobObject') {
            throw 'FAULT_INJECT_ASSIGNPROCESSTOJOBOBJECT'
        }
        if (-not $native::AssignProcessToJobObject($JobHandle, $processHandle)) {
            Throw-RunnerWin32 'AssignProcessToJobObject'
        }
        $inJobBuffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(4)
        try {
            [Runtime.InteropServices.Marshal]::WriteInt32($inJobBuffer, 0)
            if (-not $native::IsProcessInJob($processHandle, $JobHandle, $inJobBuffer)) {
                Throw-RunnerWin32 'IsProcessInJob'
            }
            if ([Runtime.InteropServices.Marshal]::ReadInt32($inJobBuffer) -eq 0) {
                throw 'PROCESS_NOT_IN_RUNNER_JOB'
            }
            $assigned = $true
        } finally {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($inJobBuffer)
        }

        $times = [Runtime.InteropServices.Marshal]::AllocHGlobal(32)
        $pathLength = [Runtime.InteropServices.Marshal]::AllocHGlobal(4)
        try {
            if (-not $native::GetProcessTimes(
                $processHandle,
                $times,
                [IntPtr]::Add($times, 8),
                [IntPtr]::Add($times, 16),
                [IntPtr]::Add($times, 24)
            )) {
                Throw-RunnerWin32 'GetProcessTimes'
            }
            $creationFileTime = [Runtime.InteropServices.Marshal]::ReadInt64($times, 0)
            $startTicks = [DateTime]::FromFileTimeUtc($creationFileTime).Ticks
            $pathBuilder = New-Object Text.StringBuilder 32768
            [Runtime.InteropServices.Marshal]::WriteInt32($pathLength, 32768)
            if (-not $native::QueryFullProcessImageNameW(
                $processHandle,
                0,
                $pathBuilder,
                $pathLength
            )) {
                Throw-RunnerWin32 'QueryFullProcessImageNameW'
            }
            $actualPath = $pathBuilder.ToString()
            if ($actualPath -cne $resolvedFile) { throw 'OWNED_PROCESS_IMAGE_PATH_MISMATCH' }
        } finally {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($times)
            [Runtime.InteropServices.Marshal]::FreeHGlobal($pathLength)
        }

        if ($FaultInjection -eq 'ResumeThread') {
            throw 'FAULT_INJECT_RESUMETHREAD'
        }
        $previousSuspendCount = $native::ResumeThread($threadHandle)
        if ($previousSuspendCount -eq [uint32]::MaxValue) { Throw-RunnerWin32 'ResumeThread' }
        if ($previousSuspendCount -ne 1) { throw 'UNEXPECTED_SUSPEND_COUNT' }
        $resumed = $true
        $process = [Diagnostics.Process]::GetProcessById($processId)
        return [pscustomobject]@{
            Process = $process
            Id = [int]$processId
            StartTicks = [long]$startTicks
            FilePath = $actualPath
        }
    } catch {
        $startError = $_
        if ($created -and -not $resumed -and $processHandle -ne [IntPtr]::Zero) {
            if (-not $native::TerminateProcess($processHandle, [uint32]0xE0000001L)) {
                throw ($startError.Exception.Message + '; TerminateProcess(failed-start) failed')
            }
            if ($native::WaitForSingleObject($processHandle, 5000) -ne 0) {
                throw ($startError.Exception.Message + '; failed-start process did not exit')
            }
        }
        if ($FaultInjection -ne 'None') {
            Write-Host "NATIVE_FAULT_CLEANUP fault=$FaultInjection pid=$processId created=$([int]$created) in_job=$([int]$assigned) resumed=$([int]$resumed)"
        }
        throw $startError
    } finally {
        if ($threadHandle -ne [IntPtr]::Zero) { [void]$native::CloseHandle($threadHandle) }
        if ($processHandle -ne [IntPtr]::Zero) { [void]$native::CloseHandle($processHandle) }
        if ($environmentBlock -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($environmentBlock)
        }
        if ($startupInfo -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($startupInfo)
        }
        if ($processInfo -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($processInfo)
        }
    }
}

function Wait-OwnedReadiness {
    param(
        [Collections.Generic.List[object]]$OwnedProcesses,
        [int[]]$Ports,
        [Threading.EventWaitHandle]$StopEvent,
        [int]$TimeoutSeconds = 90
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($null -ne $StopEvent -and $StopEvent.WaitOne(0)) {
            throw (New-Object OperationCanceledException('RUNNER_STOP_REQUESTED'))
        }
        $failed = @($OwnedProcesses | Where-Object { $_.Process.HasExited })
        if ($failed.Count -gt 0) { throw 'A bounded child exited before readiness.' }
        $ready = $true
        foreach ($port in $Ports) {
            $client = New-Object Net.Sockets.TcpClient
            try {
                $connected = $client.ConnectAsync('127.0.0.1', $port).Wait(300)
                if (-not $connected -or -not $client.Connected) { $ready = $false; break }
            } catch {
                $ready = $false
                break
            } finally {
                $client.Dispose()
            }
        }
        if ($ready) { return }
        Start-Sleep -Milliseconds 250
    }
    throw 'Loopback readiness deadline exceeded for ports 11434, 7880, 8787, and 3000.'
}

function Assert-OwnedProcessesAlive([Collections.Generic.List[object]]$OwnedProcesses) {
    $failed = @($OwnedProcesses | Where-Object { $_.Process.HasExited })
    if ($failed.Count -gt 0) { throw 'A bounded child exited before agent registration readiness.' }
}

function Invoke-AgentHttpGet([string]$Path, [int]$TimeoutMilliseconds = 500) {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:6567$Path")
    $request.Method = 'GET'
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.KeepAlive = $false
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $response = $null
    try {
        try {
            $response = [Net.HttpWebResponse]$request.GetResponse()
        } catch [Net.WebException] {
            if ($null -eq $_.Exception.Response) { throw }
            $response = [Net.HttpWebResponse]$_.Exception.Response
        }
        $memory = New-Object IO.MemoryStream
        try {
            $stream = $response.GetResponseStream()
            try {
                $stream.CopyTo($memory)
            } finally {
                $stream.Dispose()
            }
            return [pscustomobject]@{
                StatusCode = [int]$response.StatusCode
                MediaType = if ([string]::IsNullOrWhiteSpace($response.ContentType)) {
                    $null
                } else {
                    $response.ContentType.Split(';')[0].Trim()
                }
                Body = [byte[]]$memory.ToArray()
            }
        } finally {
            $memory.Dispose()
        }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Wait-AgentRegistrationReadiness {
    param(
        [Collections.Generic.List[object]]$OwnedProcesses,
        [Threading.EventWaitHandle]$StopEvent,
        [int]$TimeoutSeconds = 30
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $lastReadinessError = 'none'
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($null -ne $StopEvent -and $StopEvent.WaitOne(0)) {
            throw (New-Object OperationCanceledException('RUNNER_STOP_REQUESTED'))
        }
        Assert-OwnedProcessesAlive $OwnedProcesses
        $listeners = @(
            [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
                Where-Object { $_.Port -eq 6567 }
        )
        if ($listeners.Count -eq 0) {
            Start-Sleep -Milliseconds 100
            continue
        }
        if (
            $listeners.Count -ne 1 -or
            -not $listeners[0].Address.Equals([Net.IPAddress]::Parse('127.0.0.1'))
        ) {
            throw 'AGENT_HEALTH_LISTENER_NOT_EXCLUSIVE_IPV4_LOOPBACK'
        }
        try {
            $health = Invoke-AgentHttpGet '/'
        } catch {
            $lastReadinessError = $_.Exception.Message
            Start-Sleep -Milliseconds 100
            continue
        }
        if ($health.StatusCode -eq 503) {
            $lastReadinessError = 'AGENT_HEALTH_STATUS_503'
            Start-Sleep -Milliseconds 100
            continue
        }
        if ($health.StatusCode -ne 200) { throw "AGENT_HEALTH_STATUS_$($health.StatusCode)" }
        if (
            $health.Body.Length -ne 2 -or
            $health.Body[0] -ne [byte]0x4f -or
            $health.Body[1] -ne [byte]0x4b
        ) {
            throw 'AGENT_HEALTH_BODY_MISMATCH'
        }

        try {
            $worker = Invoke-AgentHttpGet '/worker'
        } catch {
            $lastReadinessError = $_.Exception.Message
            Start-Sleep -Milliseconds 100
            continue
        }
        if ($worker.StatusCode -ne 200) { throw "AGENT_WORKER_STATUS_$($worker.StatusCode)" }
        if ($worker.MediaType -cne 'application/json') { throw 'AGENT_WORKER_CONTENT_TYPE_MISMATCH' }
        try {
            $workerText = $strictUtf8.GetString($worker.Body)
            if (
                ([regex]::Matches($workerText, '"agent_name"\s*:')).Count -ne 1 -or
                ([regex]::Matches($workerText, '"worker_type"\s*:')).Count -ne 1
            ) {
                throw 'AGENT_WORKER_REQUIRED_KEY_CARDINALITY'
            }
            $workerJson = ConvertFrom-Json -InputObject $workerText
        } catch {
            throw 'AGENT_WORKER_INVALID_JSON'
        }
        if ($workerJson -is [Collections.IEnumerable] -and $workerJson -isnot [pscustomobject]) {
            throw 'AGENT_WORKER_INVALID_JSON_SHAPE'
        }
        if ($workerJson.agent_name -isnot [string] -or $workerJson.agent_name -cne 'my-agent') {
            throw 'AGENT_WORKER_NAME_MISMATCH'
        }
        if ($workerJson.worker_type -isnot [string] -or $workerJson.worker_type -cne 'JT_ROOM') {
            throw 'AGENT_WORKER_TYPE_MISMATCH'
        }
        Assert-OwnedProcessesAlive $OwnedProcesses
        return
    }
    throw "AGENT_REGISTRATION_READINESS_TIMEOUT last_error=$lastReadinessError"
}

function New-ControlId {
    $bytes = New-Object byte[] 12
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    return -join @($bytes | ForEach-Object { $_.ToString('x2') })
}

function Assert-ControlId([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -cnotmatch '^[0-9a-f]{24}$') {
        throw 'INVALID_OR_MISSING_CONTROL_ID'
    }
}

function Get-ControlNames([string]$Value) {
    Assert-ControlId $Value
    return @{
        Stop = "Local\PAIOS-DemoGateway-$Value-Stop"
        Claim = "Local\PAIOS-DemoGateway-$Value-Claim"
    }
}

function New-RunnerControl([string]$CandidateControlId) {
    $value = if ([string]::IsNullOrWhiteSpace($CandidateControlId)) {
        New-ControlId
    } else {
        Assert-ControlId $CandidateControlId
        $CandidateControlId
    }
    $names = Get-ControlNames $value
    $eventCreated = $false
    $claimCreated = $false
    $stopEvent = New-Object Threading.EventWaitHandle(
        $false,
        [Threading.EventResetMode]::ManualReset,
        $names.Stop,
        [ref]$eventCreated
    )
    if (-not $eventCreated) {
        $stopEvent.Dispose()
        throw 'CONTROL_ID_COLLISION'
    }
    $claim = $null
    try {
        $claim = New-Object Threading.Semaphore(1, 1, $names.Claim, [ref]$claimCreated)
        if (-not $claimCreated) { throw 'CONTROL_ID_COLLISION' }
        return [pscustomobject]@{
            Id = $value
            StopEvent = $stopEvent
            Claim = $claim
        }
    } catch {
        if ($null -ne $claim) { $claim.Dispose() }
        $stopEvent.Dispose()
        throw
    }
}

function Dispose-RunnerControl([psobject]$Control) {
    if ($null -eq $Control) { return }
    $Control.Claim.Dispose()
    $Control.StopEvent.Dispose()
}

function Invoke-Stop([string]$Value) {
    $names = Get-ControlNames $Value
    $event = $null
    $claim = $null
    try {
        try {
            $event = [Threading.EventWaitHandle]::OpenExisting($names.Stop)
            $claim = [Threading.Semaphore]::OpenExisting($names.Claim)
        } catch [Threading.WaitHandleCannotBeOpenedException] {
            throw 'CONTROL_NOT_ACTIVE'
        }
        if (-not $claim.WaitOne(0)) { throw 'CONTROL_STOP_ALREADY_CLAIMED' }
        if (-not $event.Set()) { throw 'CONTROL_SIGNAL_FAILED' }
        Write-Host "STOP_SIGNALLED control_id=$Value"
    } finally {
        if ($null -ne $claim) { $claim.Dispose() }
        if ($null -ne $event) { $event.Dispose() }
    }
}

function Assert-LoopbackPortsFree {
    $properties = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
    $tcpListeners = @($properties.GetActiveTcpListeners())
    $udpListeners = @($properties.GetActiveUdpListeners())
    $occupied = New-Object 'System.Collections.Generic.List[string]'
    foreach ($port in @(3000, 6567, 7880, 7881, 8787, 11434)) {
        if (@($tcpListeners | Where-Object { $_.Port -eq $port }).Count -gt 0) {
            $occupied.Add("TCP/$port")
        }
    }
    if (@($udpListeners | Where-Object { $_.Port -eq 7882 }).Count -gt 0) {
        $occupied.Add('UDP/7882')
    }
    if ($occupied.Count -gt 0) {
        throw ('Required loopback ports are already occupied: ' + ($occupied -join ', '))
    }
}

function Assert-OwnedProcessIdentity([psobject]$Owned) {
    $current = Get-Process -Id $Owned.Id -ErrorAction SilentlyContinue
    if ($null -eq $current) { return $false }
    $current.Refresh()
    $currentPath = $null
    try { $currentPath = (Resolve-Path -LiteralPath $current.Path).Path } catch { }
    $currentTicks = [long]$current.StartTime.ToUniversalTime().Ticks
    if ($currentTicks -ne $Owned.StartTicks -or $currentPath -ne $Owned.FilePath) {
        throw "Owned process identity changed for frozen PID $($Owned.Id); refusing termination"
    }
    return $true
}

function Wait-OwnedProcessesGone {
    param(
        [Collections.Generic.List[object]]$OwnedProcesses,
        [int]$TimeoutSeconds = 15
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $remaining = New-Object 'System.Collections.Generic.List[int]'
        foreach ($owned in $OwnedProcesses) {
            $current = Get-Process -Id $owned.Id -ErrorAction SilentlyContinue
            if ($null -eq $current) { continue }
            $current.Refresh()
            $path = $null
            try { $path = (Resolve-Path -LiteralPath $current.Path).Path } catch { }
            $ticks = [long]$current.StartTime.ToUniversalTime().Ticks
            if ($ticks -eq $owned.StartTicks -and $path -eq $owned.FilePath) {
                $remaining.Add($owned.Id)
            }
        }
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    }
    throw 'RUNNER_JOB_MEMBERS_REMAIN_AFTER_CLOSE'
}

function Wait-RunnerCleanupState {
    param(
        [Collections.Generic.List[object]]$OwnedProcesses,
        [int[]]$JobProcessIds,
        [int[]]$TcpPorts,
        [int[]]$UdpPorts = @(),
        [int]$TimeoutSeconds = 15
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $remainingOwned = New-Object 'System.Collections.Generic.List[int]'
        foreach ($owned in $OwnedProcesses) {
            $current = Get-Process -Id $owned.Id -ErrorAction SilentlyContinue
            if ($null -eq $current) { continue }
            $current.Refresh()
            $path = $null
            try { $path = (Resolve-Path -LiteralPath $current.Path).Path } catch { }
            $ticks = [long]$current.StartTime.ToUniversalTime().Ticks
            if ($ticks -eq $owned.StartTicks -and $path -eq $owned.FilePath) {
                $remainingOwned.Add($owned.Id)
            }
        }
        $remainingJobMembers = @($JobProcessIds | Where-Object {
            $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue)
        })
        $properties = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
        $tcpListeners = @($properties.GetActiveTcpListeners())
        $udpListeners = @($properties.GetActiveUdpListeners())
        $occupiedTcp = @($TcpPorts | Where-Object {
            $candidatePort = $_
            @($tcpListeners | Where-Object { $_.Port -eq $candidatePort }).Count -gt 0
        })
        $occupiedUdp = @($UdpPorts | Where-Object {
            $candidatePort = $_
            @($udpListeners | Where-Object { $_.Port -eq $candidatePort }).Count -gt 0
        })
        if (
            $remainingOwned.Count -eq 0 -and
            $remainingJobMembers.Count -eq 0 -and
            $occupiedTcp.Count -eq 0 -and
            $occupiedUdp.Count -eq 0
        ) {
            return
        }
        Start-Sleep -Milliseconds 50
    }
    throw 'RUNNER_CLEANUP_STATE_TIMEOUT'
}

function Assert-RunnerControlDisposed([string]$Value) {
    $names = Get-ControlNames $Value
    foreach ($target in @(
        @{ Name = $names.Stop; Kind = 'event' },
        @{ Name = $names.Claim; Kind = 'semaphore' }
    )) {
        $handle = $null
        try {
            if ($target.Kind -eq 'event') {
                $handle = [Threading.EventWaitHandle]::OpenExisting($target.Name)
            } else {
                $handle = [Threading.Semaphore]::OpenExisting($target.Name)
            }
            throw 'RUNNER_CONTROL_OBJECT_REMAINS'
        } catch [Threading.WaitHandleCannotBeOpenedException] {
        } finally {
            if ($null -ne $handle) { $handle.Dispose() }
        }
    }
}

function Get-DiagnosticNode {
    $configured = Get-ProcessInput 'PAIOS_NODE_EXE'
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        return Resolve-ExistingFile $configured 'PAIOS_NODE_EXE'
    }
    return Resolve-ExistingFile 'C:\Program Files\nodejs\node.exe' 'System Node'
}

function Assert-NodeIdentity([string]$NodeExe) {
    $nodeVersion = (& $NodeExe --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v24.18.0') {
        throw 'Node executable must be exact v24.18.0'
    }
}

function Assert-NodeFileIdentity([string]$NodeExe) {
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($NodeExe)
    if ($version.FileVersion -ne '24.18.0' -or $version.ProductVersion -ne '24.18.0') {
        throw 'Node executable file identity must be exact 24.18.0'
    }
}

function Invoke-ArgumentRoundTrip([string]$NodeExe, [string]$WorkingDirectory) {
    $sentinel = @('', 'plain', 'space value', 'trailing\', 'quote"value', 'space and trailing\\')
    $nodeScript = 'process.stdout.write(JSON.stringify({values:process.argv.slice(1)}))'
    $arguments = @('-e', $nodeScript, '--') + $sentinel
    $info = New-OwnedProcessStartInfo $NodeExe $arguments $WorkingDirectory @{}
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'Argument round-trip child failed to start' }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Argument round-trip child failed: $stderr" }
    $payload = $stdout | ConvertFrom-Json
    $actual = @($payload.values)
    if ($actual.Count -ne $sentinel.Count) { throw 'Argument round-trip count mismatch' }
    for ($index = 0; $index -lt $sentinel.Count; $index += 1) {
        if ([string]$actual[$index] -cne [string]$sentinel[$index]) {
            throw "Argument round-trip mismatch at index $index"
        }
    }
}

function Get-RunnerLayout {
    $repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
    return @{
        Repo = $repo
        Gateway = (Resolve-Path -LiteralPath $PSScriptRoot).Path
        NodeStarter = Resolve-ExistingDirectory (Join-Path $repo 'upstream\phase0\LiveKit_Agent_Starter_Node') 'Node starter'
        ReactStarter = Resolve-ExistingDirectory (Join-Path $repo 'upstream\phase0\LiveKit_Agent_Starter_React') 'React starter'
    }
}

function Assert-OptionalRuntimeInputs {
    $names = @('PAIOS_NODE_EXE', 'PAIOS_LIVEKIT_SERVER_EXE', 'PAIOS_OLLAMA_EXE', 'PAIOS_OLLAMA_MODELS')
    $present = @($names | Where-Object { -not [string]::IsNullOrWhiteSpace((Get-ProcessInput $_)) })
    if ($present.Count -ne 0 -and $present.Count -ne $names.Count) {
        $missing = @($names | Where-Object { [string]::IsNullOrWhiteSpace((Get-ProcessInput $_)) })
        throw ('Partial runtime input set; missing: ' + ($missing -join ', '))
    }
    if ($present.Count -eq $names.Count) {
        [void](Resolve-ExistingFile (Get-ProcessInput 'PAIOS_NODE_EXE') 'PAIOS_NODE_EXE')
        [void](Resolve-ExistingFile (Get-ProcessInput 'PAIOS_LIVEKIT_SERVER_EXE') 'PAIOS_LIVEKIT_SERVER_EXE')
        [void](Resolve-ExistingFile (Get-ProcessInput 'PAIOS_OLLAMA_EXE') 'PAIOS_OLLAMA_EXE')
        [void](Resolve-ExistingDirectory (Get-ProcessInput 'PAIOS_OLLAMA_MODELS') 'PAIOS_OLLAMA_MODELS')
        return $true
    }
    return $false
}

function Invoke-RunnerSelfTest {
    $layout = Get-RunnerLayout
    $nodeExe = Get-DiagnosticNode
    Assert-NodeIdentity $nodeExe
    Invoke-ArgumentRoundTrip $nodeExe $layout.Gateway
    $cases = 0

    foreach ($invalid in @($null, '', 'ABC', ('f' * 25))) {
        try {
            Invoke-Stop $invalid
            throw 'SELFTEST_EXPECTED_INVALID_CONTROL_ID'
        } catch {
            if ($_.Exception.Message -notmatch 'INVALID_OR_MISSING_CONTROL_ID') { throw }
            $cases += 1
        }
    }

    $collisionId = New-ControlId
    $collisionNames = Get-ControlNames $collisionId
    $created = $false
    $collision = New-Object Threading.EventWaitHandle(
        $false,
        [Threading.EventResetMode]::ManualReset,
        $collisionNames.Stop,
        [ref]$created
    )
    try {
        if (-not $created) { throw 'SELFTEST_COLLISION_SETUP_FAILED' }
        try {
            [void](New-RunnerControl $collisionId)
            throw 'SELFTEST_EXPECTED_CONTROL_COLLISION'
        } catch {
            if ($_.Exception.Message -notmatch 'CONTROL_ID_COLLISION') { throw }
            if ($collision.WaitOne(0)) { throw 'COLLISION_EVENT_WAS_SIGNALLED' }
            $cases += 1
        }
    } finally {
        $collision.Dispose()
    }

    $control = $null
    $job = [IntPtr]::Zero
    $jobMemberIds = @()
    $owned = New-Object 'System.Collections.Generic.List[object]'
    try {
        $control = New-RunnerControl
        $job = New-RunnerJob
        $owned.Add((Start-OwnedProcess $nodeExe @(
            '-e',
            'setInterval(() => {}, 1000)'
        ) $layout.Gateway @{} $job))
        if ((Get-RunnerJobActiveCount $job) -lt 1) { throw 'SELFTEST_JOB_MEMBER_MISSING' }
        $foreign = [pscustomobject]@{
            Process = $owned[0].Process
            Id = $owned[0].Id
            StartTicks = $owned[0].StartTicks + 1
            FilePath = $owned[0].FilePath
        }
        try {
            [void](Assert-OwnedProcessIdentity $foreign)
            throw 'SELFTEST_EXPECTED_FOREIGN_IDENTITY_REJECTION'
        } catch {
            if ($_.Exception.Message -notmatch 'identity changed') { throw }
            if ($owned[0].Process.HasExited) { throw 'FOREIGN_PROCESS_WAS_TERMINATED' }
            $cases += 1
        }
        $foreignPath = [pscustomobject]@{
            Process = $owned[0].Process
            Id = $owned[0].Id
            StartTicks = $owned[0].StartTicks
            FilePath = $owned[0].FilePath + '.foreign'
        }
        try {
            [void](Assert-OwnedProcessIdentity $foreignPath)
            throw 'SELFTEST_EXPECTED_FOREIGN_PATH_REJECTION'
        } catch {
            if ($_.Exception.Message -notmatch 'identity changed') { throw }
            if ($owned[0].Process.HasExited) { throw 'FOREIGN_PROCESS_WAS_TERMINATED' }
            $cases += 1
        }
        $foreignPid = [pscustomobject]@{
            Process = [Diagnostics.Process]::GetCurrentProcess()
            Id = $PID
            StartTicks = $owned[0].StartTicks
            FilePath = $owned[0].FilePath
        }
        try {
            [void](Assert-OwnedProcessIdentity $foreignPid)
            throw 'SELFTEST_EXPECTED_FOREIGN_PID_REJECTION'
        } catch {
            if ($_.Exception.Message -notmatch 'identity changed') { throw }
            if (-not (Get-Process -Id $PID -ErrorAction SilentlyContinue)) {
                throw 'FOREIGN_PROCESS_WAS_TERMINATED'
            }
            $cases += 1
        }
        Invoke-Stop $control.Id
        if (-not $control.StopEvent.WaitOne(0)) { throw 'SELFTEST_STOP_NOT_SIGNALLED' }
        try {
            Invoke-Stop $control.Id
            throw 'SELFTEST_EXPECTED_REPEATED_STOP_REJECTION'
        } catch {
            if ($_.Exception.Message -notmatch 'CONTROL_STOP_ALREADY_CLAIMED') { throw }
            $cases += 1
        }
    } finally {
        foreach ($item in $owned) {
            if (-not $item.Process.HasExited) { [void](Assert-OwnedProcessIdentity $item) }
        }
        if ($job -ne [IntPtr]::Zero) {
            $jobMemberIds = @(Get-RunnerJobProcessIds $job)
            Close-RunnerJob $job
            $job = [IntPtr]::Zero
        }
        Wait-RunnerCleanupState $owned $jobMemberIds @()
        if ($null -ne $control) {
            $lateId = $control.Id
            Dispose-RunnerControl $control
            $control = $null
            Assert-RunnerControlDisposed $lateId
            try {
                Invoke-Stop $lateId
                throw 'SELFTEST_EXPECTED_LATE_STOP_REJECTION'
            } catch {
                if ($_.Exception.Message -notmatch 'CONTROL_NOT_ACTIVE') { throw }
                $cases += 1
            }
        }
    }
    Write-Host "SELFTEST_OK services_started=0 powershell_5_1_compatible=1 argument_roundtrip=1 cases=$cases critical=0"
}

function Wait-FixturePort([int]$Port, [Threading.EventWaitHandle]$StopEvent) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($StopEvent.WaitOne(0)) {
            throw (New-Object OperationCanceledException('RUNNER_STOP_REQUESTED'))
        }
        $client = New-Object Net.Sockets.TcpClient
        try {
            if ($client.ConnectAsync('127.0.0.1', $Port).Wait(100) -and $client.Connected) { return }
        } catch {
        } finally {
            $client.Dispose()
        }
        Start-Sleep -Milliseconds 50
    }
    throw 'FIXTURE_PORT_READINESS_TIMEOUT'
}

function Invoke-LifecycleFixture {
    $layout = Get-RunnerLayout
    $nodeExe = Get-DiagnosticNode
    Assert-NodeFileIdentity $nodeExe
    Assert-LoopbackPortsFree
    $control = $null
    $job = [IntPtr]::Zero
    $jobMemberIds = @()
    $owned = New-Object 'System.Collections.Generic.List[object]'
    $primaryError = $null
    $controlledStop = $false
    try {
        $control = New-RunnerControl
        $job = New-RunnerJob
        Write-Host "RUNNER_CONTROL_READY control_id=$($control.Id)"
        if ($FixtureStage -eq 'exit-zero' -or $FixtureStage -eq 'exit-nonzero') {
            $exitCode = if ($FixtureStage -eq 'exit-zero') { 0 } else { 17 }
            $fixtureScript = "setTimeout(() => process.exit($exitCode), 250)"
        } else {
            $delay = if ($FixtureStage -eq 'steady') { 0 } elseif ($FixtureStage -eq 'readiness') { 3000 } else { 10000 }
            $grandchild = @"
const net=require('node:net');
setTimeout(()=>net.createServer().listen($FixturePort,'127.0.0.1'),$delay);
setInterval(()=>{},1000);
"@
            $grandchildJson = $grandchild | ConvertTo-Json -Compress
            $fixtureScript = @"
const {spawn}=require('node:child_process');
const forbidden=['PAIOS_RUNNER_CONTROL_ID','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','LIVEKIT_KEYS'];
if(forbidden.some((name)=>Object.hasOwn(process.env,name))) process.exit(91);
spawn(process.execPath,['-e',$grandchildJson],{stdio:'ignore'});
setInterval(()=>{},1000);
"@
        }
        $owned.Add((Start-OwnedProcess $nodeExe @('-e', $fixtureScript) $layout.Gateway @{} $job))
        if ((Get-RunnerJobActiveCount $job) -lt 1) { throw 'FIXTURE_JOB_MEMBER_MISSING' }
        if ($FixtureStage -eq 'steady') { Wait-FixturePort $FixturePort $control.StopEvent }
        Write-Host "FIXTURE_STAGE stage=$FixtureStage owned_pid=$($owned[0].Id) port=$FixturePort"
        while ($true) {
            if ($control.StopEvent.WaitOne(100)) {
                $controlledStop = $true
                break
            }
            if ($owned[0].Process.HasExited) {
                throw "FIXTURE_CHILD_EXITED code=$($owned[0].Process.ExitCode)"
            }
        }
    } catch [OperationCanceledException] {
        $controlledStop = $true
    } catch {
        $primaryError = $_
    } finally {
        foreach ($item in $owned) {
            if (-not $item.Process.HasExited) {
                try { [void](Assert-OwnedProcessIdentity $item) } catch {
                    if ($null -eq $primaryError) { $primaryError = $_ }
                }
            }
        }
        if ($job -ne [IntPtr]::Zero) {
            try {
                $jobMemberIds = @(Get-RunnerJobProcessIds $job)
                Close-RunnerJob $job
            } catch {
                if ($null -eq $primaryError) { $primaryError = $_ }
            }
            $job = [IntPtr]::Zero
        }
        try { Wait-RunnerCleanupState $owned $jobMemberIds @($FixturePort) } catch {
            if ($null -eq $primaryError) { $primaryError = $_ }
        }
        if ($null -ne $control) {
            $disposedControlId = $control.Id
            Dispose-RunnerControl $control
            $control = $null
            try { Assert-RunnerControlDisposed $disposedControlId } catch {
                if ($null -eq $primaryError) { $primaryError = $_ }
            }
        }
    }
    if ($null -ne $primaryError) { throw $primaryError }
    if (-not $controlledStop) { throw 'FIXTURE_EXIT_WITHOUT_CONTROLLED_STOP' }
    Write-Host "RUNNER_STOPPED cleanup_complete=1 stage=$FixtureStage"
}

function Invoke-AgentReadinessFixture {
    $layout = Get-RunnerLayout
    $nodeExe = Get-DiagnosticNode
    Assert-NodeIdentity $nodeExe
    Assert-LoopbackPortsFree
    $control = $null
    $job = [IntPtr]::Zero
    $jobMemberIds = @()
    $owned = New-Object 'System.Collections.Generic.List[object]'
    $primaryError = $null
    $cleanupErrors = New-Object 'System.Collections.Generic.List[string]'
    $fixtureScript = @"
const http = require('node:http');
const {spawn} = require('node:child_process');
const mode = '$FixtureAgentMode';
const host = mode === 'non-loopback' ? '0.0.0.0' : '127.0.0.1';
const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
process.stdout.write('AGENT_FIXTURE_DESCENDANT_PID=' + descendant.pid + '\n');
const server = http.createServer((request, response) => {
  if (mode === 'timeout') return;
  if (request.url === '/') {
    if (mode === '503') {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('NOT_READY');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('OK');
    return;
  }
  if (request.url === '/worker') {
    const contentType = mode === 'wrong-content-type' ? 'text/plain' : 'application/json';
    response.writeHead(200, { 'content-type': contentType });
    if (mode === 'invalid-json') response.end('{');
    else response.end(JSON.stringify({
      agent_name: mode === 'wrong-agent' ? 'foreign-agent' : 'my-agent',
      worker_type: mode === 'wrong-worker-type' ? 'JT_PUBLISHER' : 'JT_ROOM',
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(6567, host);
setInterval(() => {}, 1000);
"@
    try {
        $control = New-RunnerControl
        $job = New-RunnerJob
        Write-Host "RUNNER_CONTROL_READY control_id=$($control.Id)"
        $owned.Add((Start-OwnedProcess $nodeExe @('-e', $fixtureScript) $layout.Gateway @{} $job))
        Write-Host "AGENT_FIXTURE_STARTED owned_pid=$($owned[0].Id)"
        if ((Get-RunnerJobActiveCount $job) -lt 1) { throw 'FIXTURE_JOB_MEMBER_MISSING' }
        Wait-FixturePort 6567 $control.StopEvent
        Wait-AgentRegistrationReadiness $owned $control.StopEvent 2
        Write-Host 'RUNNER_READY services=1 agent_registered=1 agent_endpoint=127.0.0.1:6567'
    } catch {
        $primaryError = $_
    } finally {
        foreach ($ownedProcess in $owned) {
            if (-not $ownedProcess.Process.HasExited) {
                try {
                    [void](Assert-OwnedProcessIdentity $ownedProcess)
                } catch {
                    $cleanupErrors.Add($_.Exception.Message)
                }
            }
        }
        if ($job -ne [IntPtr]::Zero) {
            try {
                $jobMemberIds = @(Get-RunnerJobProcessIds $job)
                Close-RunnerJob $job
            } catch { $cleanupErrors.Add($_.Exception.Message) }
            $job = [IntPtr]::Zero
        }
        try {
            Wait-RunnerCleanupState $owned $jobMemberIds @(3000, 6567, 7880, 7881, 8787, 11434) @(7882)
        } catch { $cleanupErrors.Add($_.Exception.Message) }
        if ($null -ne $control) {
            $disposedControlId = $control.Id
            Dispose-RunnerControl $control
            $control = $null
            try { Assert-RunnerControlDisposed $disposedControlId } catch {
                $cleanupErrors.Add($_.Exception.Message)
            }
        }
    }
    if ($null -ne $primaryError) {
        if ($cleanupErrors.Count -gt 0) {
            throw ($primaryError.Exception.Message + '; cleanup failures: ' + ($cleanupErrors -join ' | '))
        }
        throw $primaryError
    }
    if ($cleanupErrors.Count -gt 0) {
        throw ('Agent readiness fixture cleanup failures: ' + ($cleanupErrors -join ' | '))
    }
}

function New-NativeFaultWitness {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $endpoint = [Net.IPEndPoint]$listener.LocalEndpoint
    return [pscustomobject]@{
        Listener = $listener
        Port = [int]$endpoint.Port
        Nonce = New-ControlId
    }
}

function Wait-NativeFaultWitness([psobject]$Witness, [int]$TimeoutMilliseconds) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while ([DateTime]::UtcNow -lt $deadline -and -not $Witness.Listener.Pending()) {
        Start-Sleep -Milliseconds 10
    }
    if (-not $Witness.Listener.Pending()) { return $false }
    $client = $Witness.Listener.AcceptTcpClient()
    try {
        $client.ReceiveTimeout = 1000
        $stream = $client.GetStream()
        $expected = [Text.Encoding]::UTF8.GetBytes($Witness.Nonce)
        $buffer = New-Object byte[] ($expected.Length + 1)
        $count = 0
        while ($count -lt $buffer.Length) {
            $received = $stream.Read($buffer, $count, $buffer.Length - $count)
            if ($received -eq 0) { break }
            $count += $received
        }
        if ($count -ne $expected.Length) {
            throw 'NATIVE_FAULT_WITNESS_NONCE_LENGTH_MISMATCH'
        }
        $observed = [Text.Encoding]::UTF8.GetString($buffer, 0, $count)
        if ($observed -cne $Witness.Nonce) {
            throw 'NATIVE_FAULT_WITNESS_NONCE_MISMATCH'
        }
        $ack = [Text.Encoding]::UTF8.GetBytes("ACK:$($Witness.Nonce)")
        $stream.Write($ack, 0, $ack.Length)
        $stream.Flush()
        return $true
    } finally {
        $client.Dispose()
    }
}

function New-NativeFaultProbeScript([int]$Port, [string]$Nonce) {
    $nonceJson = $Nonce | ConvertTo-Json -Compress
    $ackJson = "ACK:$Nonce" | ConvertTo-Json -Compress
    return @"
const net=require('node:net');
const nonce=Buffer.from($nonceJson,'utf8');
const expectedAck=Buffer.from($ackJson,'utf8');
let observedAck=Buffer.alloc(0);
let settled=false;
const finish=(code)=>{
  if(settled)return;
  settled=true;
  clearTimeout(watchdog);
  process.exit(code);
};
const watchdog=setTimeout(()=>finish(92),2000);
const socket=net.connect($Port,'127.0.0.1');
socket.once('connect',()=>socket.end(nonce));
socket.on('data',(chunk)=>{
  if(settled)return;
  observedAck=Buffer.concat([observedAck,chunk]);
  if(observedAck.length>expectedAck.length||
     !expectedAck.subarray(0,observedAck.length).equals(observedAck)){
    finish(90);
    return;
  }
  if(observedAck.length===expectedAck.length)finish(0);
});
socket.once('end',()=>finish(93));
socket.once('error',()=>finish(91));
"@
}

function Invoke-NativeFaultFixture {
    if ($FixtureNativeFault -eq 'None') { throw 'NATIVE_FAULT_FIXTURE_REQUIRES_FAULT' }
    $layout = Get-RunnerLayout
    $nodeExe = Get-DiagnosticNode
    Assert-NodeIdentity $nodeExe
    Assert-LoopbackPortsFree
    $control = $null
    $job = [IntPtr]::Zero
    $jobMemberIds = @()
    $owned = New-Object 'System.Collections.Generic.List[object]'
    $primaryError = $null
    $cleanupErrors = New-Object 'System.Collections.Generic.List[string]'
    $positiveWitness = $null
    $faultWitness = $null
    $positiveOwned = $null
    $positiveHandleCached = $false
    $witnessPorts = New-Object 'System.Collections.Generic.List[int]'
    try {
        $control = New-RunnerControl
        $job = New-RunnerJob
        Write-Host "RUNNER_CONTROL_READY control_id=$($control.Id)"

        $positiveWitness = New-NativeFaultWitness
        $witnessPorts.Add($positiveWitness.Port)
        $positiveScript = New-NativeFaultProbeScript $positiveWitness.Port $positiveWitness.Nonce
        $positiveOwned = Start-OwnedProcess `
            $nodeExe `
            @('-e', $positiveScript) `
            $layout.Gateway `
            @{} `
            $job `
            'None'
        $owned.Add($positiveOwned)
        try {
            $positiveProcessHandle = [IntPtr]$positiveOwned.Process.Handle
        } catch {
            throw 'NATIVE_FAULT_POSITIVE_CONTROL_HANDLE_UNAVAILABLE'
        }
        if ($positiveProcessHandle -eq [IntPtr]::Zero) {
            throw 'NATIVE_FAULT_POSITIVE_CONTROL_HANDLE_UNAVAILABLE'
        }
        $positiveHandleCached = $true
        if (-not (Wait-NativeFaultWitness $positiveWitness 5000)) {
            throw 'NATIVE_FAULT_POSITIVE_CONTROL_NOT_OBSERVED'
        }
        $positiveExited = $positiveOwned.Process.WaitForExit(5000)
        if (-not $positiveExited) {
            throw 'NATIVE_FAULT_POSITIVE_CONTROL_TIMEOUT exited_within_5s=0 exit_code=unavailable'
        }
        if ($positiveOwned.Process.HasExited -ne $true) {
            throw 'NATIVE_FAULT_POSITIVE_CONTROL_STATE_INCONSISTENT exited_within_5s=1 has_exited=0'
        }
        $positiveExitCode = $positiveOwned.Process.ExitCode
        if ($null -eq $positiveExitCode) {
            throw 'NATIVE_FAULT_POSITIVE_CONTROL_EXIT_UNKNOWN exited_within_5s=1 exit_code=unavailable'
        }
        if ($positiveExitCode -isnot [int]) {
            throw "NATIVE_FAULT_POSITIVE_CONTROL_EXIT_NONINTEGER exited_within_5s=1 type=$($positiveExitCode.GetType().FullName)"
        }
        if ($positiveExitCode -ne 0) {
            throw "NATIVE_FAULT_POSITIVE_CONTROL_EXIT_NONZERO exited_within_5s=1 exit_code=$positiveExitCode"
        }
        Write-Host 'NATIVE_FAULT_WITNESS positive_control=1 exact_nonce=1'
        $positiveWitness.Listener.Stop()
        $positiveWitness = $null

        $faultWitness = New-NativeFaultWitness
        $witnessPorts.Add($faultWitness.Port)
        $faultScript = New-NativeFaultProbeScript $faultWitness.Port $faultWitness.Nonce
        try {
            $unexpectedOwned = Start-OwnedProcess `
                $nodeExe `
                @('-e', $faultScript) `
                $layout.Gateway `
                @{} `
                $job `
                $FixtureNativeFault
            $owned.Add($unexpectedOwned)
            throw 'NATIVE_FAULT_INJECTION_DID_NOT_FIRE'
        } catch {
            $primaryError = $_
        }
        if (Wait-NativeFaultWitness $faultWitness 750) {
            throw 'NATIVE_FAULT_USER_CODE_OBSERVED'
        }
        Write-Host "NATIVE_FAULT_WITNESS fault=$FixtureNativeFault observed=0"
    } catch {
        $primaryError = $_
    } finally {
        if ($null -ne $positiveWitness) {
            try { $positiveWitness.Listener.Stop() } catch { $cleanupErrors.Add($_.Exception.Message) }
        }
        if ($null -ne $faultWitness) {
            try { $faultWitness.Listener.Stop() } catch { $cleanupErrors.Add($_.Exception.Message) }
        }
        if ($job -ne [IntPtr]::Zero) {
            try {
                $jobMemberIds = @(Get-RunnerJobProcessIds $job)
                Close-RunnerJob $job
            } catch { $cleanupErrors.Add($_.Exception.Message) }
            $job = [IntPtr]::Zero
        }
        try { Wait-RunnerCleanupState $owned $jobMemberIds @($witnessPorts) } catch {
            $cleanupErrors.Add($_.Exception.Message)
        }
        if ($null -ne $positiveOwned) {
            try { $positiveOwned.Process.Dispose() } catch {
                $cleanupErrors.Add('NATIVE_FAULT_POSITIVE_CONTROL_PROCESS_DISPOSE_FAILED: ' + $_.Exception.Message)
            }
        }
        if ($null -ne $control) {
            $disposedControlId = $control.Id
            Dispose-RunnerControl $control
            $control = $null
            try { Assert-RunnerControlDisposed $disposedControlId } catch {
                $cleanupErrors.Add($_.Exception.Message)
            }
        }
        try { Assert-LoopbackPortsFree } catch { $cleanupErrors.Add($_.Exception.Message) }
    }
    if ($null -eq $primaryError) { throw 'NATIVE_FAULT_FIXTURE_MISSING_PRIMARY_ERROR' }
    if ($cleanupErrors.Count -gt 0) {
        throw ($primaryError.Exception.Message + '; cleanup failures: ' + ($cleanupErrors -join ' | '))
    }
    Write-Host "NATIVE_FAULT_FIXTURE_CLEAN fault=$FixtureNativeFault job_members=0 witnesses_disposed=1 controls_disposed=1"
    throw $primaryError
}

function Wait-HarnessPort([int]$Port, [Diagnostics.Process]$RootProcess, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $RootProcess.Refresh()
        if ($RootProcess.HasExited) {
            throw "TEST_HARNESS_ROOT_EXITED_BEFORE_PORT code=$($RootProcess.ExitCode)"
        }
        $client = New-Object Net.Sockets.TcpClient
        try {
            if ($client.ConnectAsync('127.0.0.1', $Port).Wait(100) -and $client.Connected) {
                return
            }
        } catch {
        } finally {
            $client.Dispose()
        }
        Start-Sleep -Milliseconds 50
    }
    throw 'TEST_HARNESS_CONTAINMENT_PORT_TIMEOUT'
}

function Get-TestHarnessResidueSnapshot([int[]]$JobProcessIds) {
    $all = @(Get-CimInstance Win32_Process)
    $remaining = @($JobProcessIds | Where-Object {
        $candidate = $_
        @($all | Where-Object { $_.ProcessId -eq $candidate }).Count -gt 0
    })
    $fixtures = @($all | Where-Object {
        $_.CommandLine -and (
            ($_.Name -ieq 'node.exe' -and $_.CommandLine -like '*NATIVE_FAULT_USER_CODE_EXECUTED*') -or
            ($_.Name -ieq 'powershell.exe' -and $_.CommandLine -like '*-File*demo-loopback.ps1*' -and (
                $_.CommandLine -like '*LifecycleFixture*' -or
                $_.CommandLine -like '*AgentReadinessFixture*' -or
                $_.CommandLine -like '*NativeFaultFixture*'
            ))
        )
    })
    $properties = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
    $tcpListeners = @($properties.GetActiveTcpListeners())
    $udpListeners = @($properties.GetActiveUdpListeners())
    $tcpResidue = @($tcpListeners | Where-Object {
        $_.Port -in @(3000, 6567, 7880, 7881, 8787, 11434) -or
        ($_.Port -ge 45191 -and $_.Port -le 45999)
    })
    $udpResidue = @($udpListeners | Where-Object { $_.Port -eq 7882 })
    return [pscustomobject]@{
        RemainingJobPids = @($remaining)
        FixtureProcesses = @($fixtures)
        TcpResidue = @($tcpResidue)
        UdpResidue = @($udpResidue)
    }
}

function Assert-TestHarnessResidueSnapshot([psobject]$Snapshot, [int]$Index) {
    if (
        $Snapshot.RemainingJobPids.Count -ne 0 -or
        $Snapshot.FixtureProcesses.Count -ne 0 -or
        $Snapshot.TcpResidue.Count -ne 0 -or
        $Snapshot.UdpResidue.Count -ne 0
    ) {
        throw "TEST_HARNESS_RESIDUE snapshot=$Index job=$($Snapshot.RemainingJobPids.Count) fixture=$($Snapshot.FixtureProcesses.Count) tcp=$($Snapshot.TcpResidue.Count) udp=$($Snapshot.UdpResidue.Count)"
    }
    Write-Host "TEST_HARNESS_RESIDUE_SNAPSHOT index=$Index job_members=0 fixtures=0 tcp=0 udp=0"
}

function Invoke-TestHarness {
    if ($HarnessCase -eq 'None') { throw 'TEST_HARNESS_CASE_REQUIRED' }
    if (
        $FixtureStage -ne 'steady' -or
        $FixtureAgentMode -ne 'valid' -or
        $FixtureNativeFault -ne 'None' -or
        $FixturePort -ne 45191
    ) {
        throw 'TEST_HARNESS_REJECTED_EXTRA_FIXTURE_INPUT'
    }

    $layout = Get-RunnerLayout
    $nodeExe = Resolve-ExistingFile 'C:\Program Files\nodejs\node.exe' 'Frozen TestHarness Node'
    Assert-NodeFileIdentity $nodeExe
    $nodeHash = (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($nodeHash -cne '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de') {
        throw 'TEST_HARNESS_NODE_HASH_DRIFT'
    }
    Assert-LoopbackPortsFree

    $environment = @{
        PAIOS_GATEWAY_TEST_HARNESS = 'R5_1'
        G_A1_EXTERNAL_GATE = '0'
    }
    $deadlineSeconds = 0
    $arguments = @()
    $containmentPort = 45199
    if ($HarnessCase -eq 'ContainmentProbe') {
        $deadlineSeconds = 45
        $powerShellJson = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') |
            ConvertTo-Json -Compress
        $runnerJson = $PSCommandPath | ConvertTo-Json -Compress
        $probeScript = @"
const {spawn}=require('node:child_process');
const child=spawn($powerShellJson,[
  '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
  '-File',$runnerJson,
  '-Action','SelfTest',
  '-SelfTestMode','LifecycleFixture',
  '-FixtureStage','steady',
  '-FixturePort','$containmentPort'
],{stdio:'inherit',windowsHide:true,env:process.env});
child.once('error',()=>process.exit(96));
child.once('exit',(code)=>process.exit(code===null?97:code));
setInterval(()=>{},1000);
"@
        $arguments = @('-e', $probeScript)
    } elseif ($HarnessCase -eq 'Stress503') {
        $deadlineSeconds = 210
        $environment.G_A1_R5_1_503_STRESS = '1'
        $arguments = @(
            '--test',
            '--test-concurrency=1',
            '--test-name-pattern=^official React dual chat representation has exactly one registered prompt path$',
            'tests/room-loopback.test.ts'
        )
    } else {
        $deadlineSeconds = 240
        $arguments = @(
            '--test',
            '--test-concurrency=1',
            'tests/contract-consumer.test.ts',
            'tests/room-loopback.test.ts'
        )
    }

    $job = [IntPtr]::Zero
    $jobMemberIds = @()
    $owned = New-Object 'System.Collections.Generic.List[object]'
    $primaryError = $null
    try {
        $job = New-RunnerJob
        $owned.Add((Start-OwnedProcess `
            -FilePath $nodeExe `
            -Arguments $arguments `
            -WorkingDirectory $layout.Gateway `
            -Environment $environment `
            -JobHandle $job `
            -MinimalEnvironment
        ))
        if ((Get-RunnerJobActiveCount $job) -lt 1) { throw 'TEST_HARNESS_ROOT_NOT_IN_JOB' }
        if ($HarnessCase -eq 'ContainmentProbe') {
            Wait-HarnessPort $containmentPort $owned[0].Process 15
            $readyMembers = @(Get-RunnerJobProcessIds $job)
            if ($readyMembers.Count -lt 3) { throw 'TEST_HARNESS_CONTAINMENT_TREE_INCOMPLETE' }
            Write-Host "TEST_HARNESS_READY case=ContainmentProbe harness_pid=$PID root_pid=$($owned[0].Id) job_members=$($readyMembers -join ',') fixture_port=$containmentPort"
            Start-Sleep -Seconds 10
            Write-Host 'TEST_HARNESS_CONTAINMENT_NORMAL_CLOSE'
        } else {
            $deadline = [DateTime]::UtcNow.AddSeconds($deadlineSeconds)
            while ([DateTime]::UtcNow -lt $deadline) {
                $owned[0].Process.Refresh()
                if ($owned[0].Process.HasExited) { break }
                Start-Sleep -Milliseconds 50
            }
            $owned[0].Process.Refresh()
            if (-not $owned[0].Process.HasExited) {
                throw "TEST_HARNESS_DEADLINE_EXCEEDED case=$HarnessCase seconds=$deadlineSeconds"
            }
            if ($owned[0].Process.ExitCode -ne 0) {
                throw "TEST_HARNESS_CHILD_FAILED case=$HarnessCase exit=$($owned[0].Process.ExitCode)"
            }
            Write-Host "TEST_HARNESS_CHILD_EXIT case=$HarnessCase exit=0"
        }
    } catch {
        $primaryError = $_
    } finally {
        if ($job -ne [IntPtr]::Zero) {
            try {
                $jobMemberIds = @(Get-RunnerJobProcessIds $job)
                Write-Host "TEST_HARNESS_FROZEN_JOB_MEMBERS case=$HarnessCase pids=$($jobMemberIds -join ',')"
                Close-RunnerJob $job
            } catch {
                if ($null -eq $primaryError) { $primaryError = $_ }
            }
            $job = [IntPtr]::Zero
        }
        try {
            $harnessPorts = @(3000, 6567, 7880, 7881, 8787, 11434) + @(45191..45999)
            Wait-RunnerCleanupState $owned $jobMemberIds $harnessPorts @(7882) 15
            $snapshot1 = Get-TestHarnessResidueSnapshot $jobMemberIds
            Assert-TestHarnessResidueSnapshot $snapshot1 1
            Start-Sleep -Milliseconds 250
            $snapshot2 = Get-TestHarnessResidueSnapshot $jobMemberIds
            Assert-TestHarnessResidueSnapshot $snapshot2 2
        } catch {
            if ($null -eq $primaryError) { $primaryError = $_ }
        }
    }
    if ($null -ne $primaryError) { throw $primaryError }
    Write-Host "TEST_HARNESS_COMPLETE case=$HarnessCase critical=0"
}

function Invoke-Preflight {
    $layout = Get-RunnerLayout
    $nodeExe = Get-DiagnosticNode
    Assert-NodeIdentity $nodeExe
    Invoke-ArgumentRoundTrip $nodeExe $layout.Gateway
    Assert-LoopbackPortsFree
    $runtimeInputsPresent = Assert-OptionalRuntimeInputs
    Write-Host "PREFLIGHT_OK services_started=0 ports_free=1 runtime_inputs_present=$([int]$runtimeInputsPresent)"
}

function Invoke-Run {
    if (-not [string]::IsNullOrWhiteSpace($ControlId)) {
        throw 'RUN_CREATES_CONTROL_ID; caller-supplied ControlId is forbidden'
    }
    $layout = Get-RunnerLayout
    $nodeExe = Resolve-ExistingFile (Require-ProcessInput 'PAIOS_NODE_EXE') 'PAIOS_NODE_EXE'
    $liveKitExe = Resolve-ExistingFile (Require-ProcessInput 'PAIOS_LIVEKIT_SERVER_EXE') 'PAIOS_LIVEKIT_SERVER_EXE'
    $ollamaExe = Resolve-ExistingFile (Require-ProcessInput 'PAIOS_OLLAMA_EXE') 'PAIOS_OLLAMA_EXE'
    $ollamaModels = Resolve-ExistingDirectory (Require-ProcessInput 'PAIOS_OLLAMA_MODELS') 'PAIOS_OLLAMA_MODELS'
    Assert-NodeFileIdentity $nodeExe
    Assert-LoopbackPortsFree
    $control = $null
    $job = [IntPtr]::Zero
    $jobMemberIds = @()

    # Credentials are generated only after all executable/path/port preflight checks pass.
    $apiKey = 'lk_' + (New-RandomCredential 18)
    $apiSecret = New-RandomCredential 36
    $common = @{
        LIVEKIT_URL = 'ws://127.0.0.1:7880'
        LIVEKIT_API_KEY = $apiKey
        LIVEKIT_API_SECRET = $apiSecret
        AGENT_NAME = 'my-agent'
    }
    $owned = New-Object 'System.Collections.Generic.List[object]'
    $primaryError = $null
    $cleanupErrors = New-Object 'System.Collections.Generic.List[string]'
    $controlledStop = $false
    try {
        $control = New-RunnerControl
        $job = New-RunnerJob
        Write-Host "RUNNER_CONTROL_READY control_id=$($control.Id)"
        # Secrets exist only in this orchestrator and explicit child environment blocks.
        $owned.Add((Start-OwnedProcess $ollamaExe @('serve') $layout.Repo @{
            OLLAMA_NO_CLOUD = '1'
            OLLAMA_HOST = '127.0.0.1:11434'
            OLLAMA_CONTEXT_LENGTH = '8192'
            OLLAMA_MODELS = $ollamaModels
        } $job))
        if ($control.StopEvent.WaitOne(0)) {
            throw (New-Object OperationCanceledException('RUNNER_STOP_REQUESTED'))
        }
        $owned.Add((Start-OwnedProcess $liveKitExe @(
            '--bind', '127.0.0.1', '--node-ip', '127.0.0.1', '--logging.level', 'warn'
        ) $layout.Repo @{
            LIVEKIT_KEYS = ($apiKey + ': ' + $apiSecret)
            LIVEKIT_ROOM_AUTO_CREATE = 'false'
        } $job))
        $owned.Add((Start-OwnedProcess $nodeExe @('src/main.ts', 'dev') $layout.NodeStarter ($common + @{
            OLLAMA_NO_CLOUD = '1'
            OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1'
            OLLAMA_MODEL = 'gemma4:12b'
        }) $job))
        $owned.Add((Start-OwnedProcess $nodeExe @(
            'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3000'
        ) $layout.ReactStarter @{
            NEXT_PUBLIC_CONN_DETAILS_ENDPOINT = 'http://127.0.0.1:8787/connection-details'
            NEXT_TELEMETRY_DISABLED = '1'
            NODE_ENV = 'development'
        } $job))
        $owned.Add((Start-OwnedProcess $nodeExe @('src/main.ts') $layout.Gateway ($common + @{
            LIVEKIT_ROOM_AUTO_CREATE = 'false'
        }) $job))
        Wait-OwnedReadiness $owned @(11434, 7880, 8787, 3000) $control.StopEvent
        Wait-AgentRegistrationReadiness $owned $control.StopEvent
        Write-Host 'RUNNER_READY services=5 agent_registered=1 agent_endpoint=127.0.0.1:6567'
        Write-Host 'Loopback demo processes started. Open http://127.0.0.1:3000 and http://127.0.0.1:8787.'
        Write-Host "Use -Action Stop -ControlId $($control.Id) from a second shell; then wait for this Run to exit."
        while ($true) {
            if ($control.StopEvent.WaitOne(500)) {
                $controlledStop = $true
                break
            }
            $failed = @($owned | Where-Object { $_.Process.HasExited })
            if ($failed.Count -gt 0) { throw 'A bounded child process exited unexpectedly.' }
        }
    } catch [OperationCanceledException] {
        $controlledStop = $true
    } catch {
        $primaryError = $_
    } finally {
        foreach ($ownedProcess in $owned) {
            if (-not $ownedProcess.Process.HasExited) {
                try {
                    [void](Assert-OwnedProcessIdentity $ownedProcess)
                } catch {
                    $cleanupErrors.Add($_.Exception.Message)
                }
            }
        }
        if ($job -ne [IntPtr]::Zero) {
            try {
                $jobMemberIds = @(Get-RunnerJobProcessIds $job)
                Close-RunnerJob $job
            } catch { $cleanupErrors.Add($_.Exception.Message) }
            $job = [IntPtr]::Zero
        }
        try {
            Wait-RunnerCleanupState $owned $jobMemberIds @(3000, 6567, 7880, 7881, 8787, 11434) @(7882)
        } catch { $cleanupErrors.Add($_.Exception.Message) }
        if ($null -ne $control) {
            $disposedControlId = $control.Id
            Dispose-RunnerControl $control
            $control = $null
            try { Assert-RunnerControlDisposed $disposedControlId } catch {
                $cleanupErrors.Add($_.Exception.Message)
            }
        }
        $apiKey = $null
        $apiSecret = $null
    }
    if ($null -ne $primaryError) {
        if ($cleanupErrors.Count -gt 0) {
            throw ($primaryError.Exception.Message + '; cleanup failures: ' + ($cleanupErrors -join ' | '))
        }
        throw $primaryError
    }
    if ($cleanupErrors.Count -gt 0) {
        throw ('Owned process cleanup failures: ' + ($cleanupErrors -join ' | '))
    }
    if (-not $controlledStop) { throw 'RUNNER_EXIT_WITHOUT_CONTROLLED_STOP' }
    Write-Host 'RUNNER_STOPPED cleanup_complete=1 guarded_ports_free=1'
}

if ($Action -ne 'SelfTest' -and $SelfTestMode -ne 'Full') {
    throw 'SelfTestMode is valid only with -Action SelfTest'
}
if ($Action -ne 'SelfTest' -and $HarnessCase -ne 'None') {
    throw 'HarnessCase is valid only with -Action SelfTest'
}
if ($SelfTestMode -ne 'TestHarness' -and $HarnessCase -ne 'None') {
    throw 'HarnessCase requires TestHarness mode'
}
if ($SelfTestMode -eq 'TestHarness' -and $HarnessCase -eq 'None') {
    throw 'TestHarness mode requires HarnessCase'
}
if ($Action -ne 'SelfTest' -and $FixturePort -ne 45191) {
    throw 'FixturePort is valid only with -Action SelfTest'
}
if ($Action -ne 'SelfTest' -and $FixtureAgentMode -ne 'valid') {
    throw 'FixtureAgentMode is valid only with -Action SelfTest'
}
if ($Action -ne 'SelfTest' -and $FixtureNativeFault -ne 'None') {
    throw 'FixtureNativeFault is valid only with -Action SelfTest'
}
if ($SelfTestMode -ne 'NativeFaultFixture' -and $FixtureNativeFault -ne 'None') {
    throw 'FixtureNativeFault requires NativeFaultFixture mode'
}

switch ($Action) {
    'SelfTest' {
        if ($SelfTestMode -eq 'LifecycleFixture') {
            Invoke-LifecycleFixture
        } elseif ($SelfTestMode -eq 'AgentReadinessFixture') {
            Invoke-AgentReadinessFixture
        } elseif ($SelfTestMode -eq 'NativeFaultFixture') {
            Invoke-NativeFaultFixture
        } elseif ($SelfTestMode -eq 'TestHarness') {
            Invoke-TestHarness
        } else {
            Invoke-RunnerSelfTest
        }
        break
    }
    'Preflight' { Invoke-Preflight; break }
    'Run' { Invoke-Run; break }
    'Stop' { Invoke-Stop $ControlId; break }
}
