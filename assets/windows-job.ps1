param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("command", "monitor")]
  [string]$Mode,

  [Parameter(Mandatory = $true, ParameterSetName = "Command")]
  [string]$CommandBase64,

  [Parameter(Mandatory = $true, ParameterSetName = "Argv")]
  [string]$ArgvBase64
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class BabelfishJob {
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint INFINITE = 0xffffffff;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private static readonly UIntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST =
        new UIntPtr(0x00020002);
    private static readonly UIntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST =
        new UIntPtr(0x0002000D);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        IntPtr returnLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        uint flags,
        ref IntPtr size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        UIntPtr attribute,
        IntPtr value,
        UIntPtr size,
        IntPtr previousValue,
        IntPtr returnSize
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out IntPtr readPipe,
        out IntPtr writePipe,
        IntPtr pipeAttributes,
        uint size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags
    );

    private static IntPtr CreateKillOnCloseJob() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(limits);
        IntPtr information = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, information, false);
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                information,
                (uint)size
            )) {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(error);
            }
        } finally {
            Marshal.FreeHGlobal(information);
        }
        return job;
    }

    private static uint ActiveProcessCount(IntPtr job) {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr information = Marshal.AllocHGlobal(size);
        try {
            if (!QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                information,
                (uint)size,
                IntPtr.Zero
            )) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            var accounting =
                (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                    information,
                    typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
                );
            return accounting.ActiveProcesses;
        } finally {
            Marshal.FreeHGlobal(information);
        }
    }

    private static void SetInheritable(IntPtr handle, bool inheritable) {
        if (!SetHandleInformation(
            handle,
            HANDLE_FLAG_INHERIT,
            inheritable ? HANDLE_FLAG_INHERIT : 0
        )) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    private static void CreateChildInputPipe(
        out IntPtr childRead,
        out IntPtr parentWrite
    ) {
        if (!CreatePipe(out childRead, out parentWrite, IntPtr.Zero, 0)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            SetInheritable(childRead, true);
            SetInheritable(parentWrite, false);
        } catch {
            CloseHandle(childRead);
            CloseHandle(parentWrite);
            throw;
        }
    }

    private static void CreateChildOutputPipe(
        out IntPtr parentRead,
        out IntPtr childWrite
    ) {
        if (!CreatePipe(out parentRead, out childWrite, IntPtr.Zero, 0)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            SetInheritable(parentRead, false);
            SetInheritable(childWrite, true);
        } catch {
            CloseHandle(parentRead);
            CloseHandle(childWrite);
            throw;
        }
    }

    private static void StartInputPump(IntPtr writeHandle) {
        var destination = new FileStream(
            new SafeFileHandle(writeHandle, true),
            FileAccess.Write
        );
        var thread = new Thread(() => {
            try {
                Console.OpenStandardInput().CopyTo(destination);
            } catch (IOException) {
                // The child may exit before consuming all input.
            } catch (ObjectDisposedException) {
                // Process teardown can close the pipe while the pump is active.
            } finally {
                destination.Dispose();
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private static Thread StartOutputPump(IntPtr readHandle, Stream destination) {
        var source = new FileStream(
            new SafeFileHandle(readHandle, true),
            FileAccess.Read
        );
        var thread = new Thread(() => {
            try {
                source.CopyTo(destination);
                destination.Flush();
            } catch (IOException) {
                // The caller may close its output pipe during process teardown.
            } catch (ObjectDisposedException) {
                // Process teardown can close the pipe while the pump is active.
            } finally {
                source.Dispose();
            }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static PROCESS_INFORMATION CreateProcessInJob(
        string commandShell,
        StringBuilder commandLine,
        IntPtr job,
        IntPtr childStdin,
        IntPtr childStdout,
        IntPtr childStderr
    ) {
        var startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = childStdin;
        startup.StartupInfo.hStdOutput = childStdout;
        startup.StartupInfo.hStdError = childStderr;

        IntPtr attributeListSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(
            IntPtr.Zero,
            2,
            0,
            ref attributeListSize
        );
        if (attributeListSize == IntPtr.Zero) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        startup.lpAttributeList = Marshal.AllocHGlobal(attributeListSize);
        IntPtr handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
        IntPtr jobList = Marshal.AllocHGlobal(IntPtr.Size);
        bool initialized = false;
        try {
            if (!InitializeProcThreadAttributeList(
                startup.lpAttributeList,
                2,
                0,
                ref attributeListSize
            )) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            initialized = true;
            Marshal.WriteIntPtr(handleList, 0, childStdin);
            Marshal.WriteIntPtr(handleList, IntPtr.Size, childStdout);
            Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, childStderr);
            if (!UpdateProcThreadAttribute(
                startup.lpAttributeList,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handleList,
                new UIntPtr((uint)(IntPtr.Size * 3)),
                IntPtr.Zero,
                IntPtr.Zero
            )) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(
                startup.lpAttributeList,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobList,
                new UIntPtr((uint)IntPtr.Size),
                IntPtr.Zero,
                IntPtr.Zero
            )) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            PROCESS_INFORMATION child;
            if (!CreateProcess(
                commandShell,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
                IntPtr.Zero,
                null,
                ref startup,
                out child
            )) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return child;
        } finally {
            if (initialized) {
                DeleteProcThreadAttributeList(startup.lpAttributeList);
            }
            Marshal.FreeHGlobal(startup.lpAttributeList);
            Marshal.FreeHGlobal(handleList);
            Marshal.FreeHGlobal(jobList);
        }
    }

    private static string QuoteArgument(string argument) {
        var quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in argument) {
            if (character == '\\') {
                backslashes++;
                continue;
            }
            quoted.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
            quoted.Append(character);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2);
        return quoted.Append('"').ToString();
    }

    public static int RunArgv(string executable, string[] arguments, string mode) {
        var commandLine = new StringBuilder(QuoteArgument(executable));
        foreach (string argument in arguments) {
            commandLine.Append(' ').Append(QuoteArgument(argument));
        }
        return RunProcess(executable, commandLine, mode);
    }

    public static int Run(string command, string mode, string commandShell) {
        return RunProcess(commandShell, new StringBuilder(
            "\"" + commandShell + "\" /d /s /c \"" + command + "\""
        ), mode);
    }

    private static int RunProcess(string executable, StringBuilder commandLine, string mode) {
        IntPtr job = CreateKillOnCloseJob();
        IntPtr childStdin;
        IntPtr parentStdin;
        IntPtr parentStdout;
        IntPtr childStdout;
        IntPtr parentStderr;
        IntPtr childStderr;
        CreateChildInputPipe(out childStdin, out parentStdin);
        CreateChildOutputPipe(out parentStdout, out childStdout);
        CreateChildOutputPipe(out parentStderr, out childStderr);

        PROCESS_INFORMATION child;
        try {
            child = CreateProcessInJob(
                executable,
                commandLine,
                job,
                childStdin,
                childStdout,
                childStderr
            );
        } catch {
            CloseHandle(childStdin);
            CloseHandle(parentStdin);
            CloseHandle(parentStdout);
            CloseHandle(childStdout);
            CloseHandle(parentStderr);
            CloseHandle(childStderr);
            CloseHandle(job);
            throw;
        }

        CloseHandle(child.hThread);
        CloseHandle(childStdin);
        CloseHandle(childStdout);
        CloseHandle(childStderr);
        StartInputPump(parentStdin);
        Thread stdoutPump = StartOutputPump(
            parentStdout,
            Console.OpenStandardOutput()
        );
        Thread stderrPump = StartOutputPump(
            parentStderr,
            Console.OpenStandardError()
        );

        WaitForSingleObject(child.hProcess, INFINITE);
        uint exitCode;
        if (!GetExitCodeProcess(child.hProcess, out exitCode)) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(child.hProcess);
            CloseHandle(job);
            throw new Win32Exception(error);
        }
        CloseHandle(child.hProcess);

        if (mode == "monitor") {
            while (ActiveProcessCount(job) > 0) {
                Thread.Sleep(100);
            }
            stdoutPump.Join();
            stderrPump.Join();
            CloseHandle(job);
            return unchecked((int)exitCode);
        }

        if (!TerminateJobObject(job, exitCode)) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }
        stdoutPump.Join();
        stderrPump.Join();
        CloseHandle(job);
        return unchecked((int)exitCode);
    }
}
"@

if ($PSCmdlet.ParameterSetName -eq "Argv") {
  $argvJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgvBase64))
  # Windows PowerShell returns the JSON array as one pipeline object.
  [string[]]$commandArgv = ConvertFrom-Json -InputObject $argvJson
  $executable = (Get-Command -Name $commandArgv[0] -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  [string[]]$arguments = @($commandArgv | Select-Object -Skip 1)
  exit [BabelfishJob]::RunArgv($executable, $arguments, $Mode)
}

$command = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($CommandBase64)
)
$systemRoot = if (
  $env:SystemRoot -and [IO.Path]::IsPathRooted($env:SystemRoot)
) {
  $env:SystemRoot
} else {
  "C:\Windows"
}
$commandShell = Join-Path $systemRoot "System32\cmd.exe"
exit [BabelfishJob]::Run($command, $Mode, $commandShell)
