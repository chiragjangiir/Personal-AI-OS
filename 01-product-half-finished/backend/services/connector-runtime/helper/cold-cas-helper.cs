using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class ColdCasHelperProtocol
{
    internal const int MaxFrameBytes = 64 * 1024;
    internal const byte OpHello = 1;
    internal const byte OpAllocate = 2;
    internal const byte OpPublish = 3;
    internal const byte OpFinalize = 4;
    internal const byte OpCleanup = 5;
    internal const byte OpCancel = 6;
    internal const byte OpShutdown = 7;
    internal const byte OpWrite = 8;
    internal const byte OpSync = 9;

    internal const byte ResponseError = 0;
    internal const byte ResponseHello = 1;
    internal const byte ResponseAllocated = 2;
    internal const byte ResponsePending = 3;
    internal const byte ResponseComplete = 4;
    internal const byte ResponseBoolean = 5;

    internal static byte[] ReadFrame(Stream input)
    {
        var header = new byte[4];
        if (!ReadExactly(input, header, 0, header.Length))
        {
            return null;
        }

        var length = BitConverter.ToUInt32(header, 0);
        if (length > MaxFrameBytes)
        {
            throw new InvalidDataException("frame exceeds the 64 KiB protocol bound");
        }

        var payload = new byte[(int)length];
        if (!ReadExactly(input, payload, 0, payload.Length))
        {
            throw new EndOfStreamException("truncated protocol frame");
        }
        return payload;
    }

    internal static void WriteFrame(Stream output, byte[] payload)
    {
        if (payload == null || payload.Length > MaxFrameBytes)
        {
            throw new InvalidDataException("response exceeds the 64 KiB protocol bound");
        }

        var header = BitConverter.GetBytes((uint)payload.Length);
        output.Write(header, 0, header.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
    }

    internal static bool ReadExactly(Stream stream, byte[] buffer, int offset, int count)
    {
        var readTotal = 0;
        while (readTotal < count)
        {
            var read = stream.Read(buffer, offset + readTotal, count - readTotal);
            if (read <= 0)
            {
                return false;
            }
            readTotal += read;
        }
        return true;
    }

    internal static string ReadString(BinaryReader reader)
    {
        var byteLength = reader.ReadUInt16();
        var value = Encoding.UTF8.GetString(reader.ReadBytes(byteLength));
        if (Encoding.UTF8.GetByteCount(value) != byteLength || value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
        {
            throw new InvalidDataException("invalid protocol string");
        }
        return value;
    }

    internal static void WriteString(BinaryWriter writer, string value)
    {
        if (value == null)
        {
            value = string.Empty;
        }
        if (value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
        {
            throw new InvalidDataException("invalid protocol string");
        }
        var bytes = Encoding.UTF8.GetBytes(value);
        if (bytes.Length > ushort.MaxValue)
        {
            throw new InvalidDataException("protocol string exceeds bound");
        }
        writer.Write((ushort)bytes.Length);
        writer.Write(bytes);
    }

    internal static byte[] Error(string code, string message)
    {
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream, Encoding.UTF8, true))
        {
            writer.Write(ResponseError);
            WriteString(writer, code);
            WriteString(writer, message);
            writer.Flush();
            return stream.ToArray();
        }
    }
}

internal sealed class ColdCasHelper
{
    private const uint GenericRead = 0x80000000;
    private const uint DeleteAccess = 0x00010000;
    private const uint FileReadAttributes = 0x00000080;
    private const uint Synchronize = 0x00100000;
    private const uint FileListDirectory = 0x00000001;
    private const uint FileAddFile = 0x00000002;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint CreateNew = 1;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint FileAttributeDirectory = 0x00000010;
    private const uint FileDispositionFlagDelete = 0x00000001;
    private const uint FileBegin = 0;
    private const int FileStandardInfoClass = 1;
    private const int FileBasicInfoClass = 0;
    private const int FileAttributeTagInfoClass = 9;
    private const int FileDispositionInfoClass = 4;
    private const int FileDispositionInfoExClass = 21;
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;
    private const int ErrorAlreadyExists = 183;
    private const int ErrorFileExists = 80;
    private const int ErrorInvalidParameter = 87;

    private readonly Dictionary<string, Allocation> allocations = new Dictionary<string, Allocation>(StringComparer.Ordinal);
    private string sessionToken;
    private bool shutdown;

    private sealed class Allocation
    {
        internal string Token;
        internal string Root;
        internal string FinalPath;
        internal string TempPath;
        internal string Hash;
        internal byte PendingStatus;
        internal ulong Bytes;
        internal string CorruptReason;
        internal SafeFileHandle TempHandle;
        internal SHA256 Digest;
        internal bool Synced;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileStandardInfo
    {
        internal long AllocationSize;
        internal long EndOfFile;
        internal uint NumberOfLinks;
        internal byte DeletePending;
        internal byte Directory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo
    {
        internal uint FileAttributes;
        internal uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfo
    {
        [MarshalAs(UnmanagedType.Bool)] internal bool DeleteRequested;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfoEx
    {
        internal uint Flags;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateHardLinkW(string fileName, string existingFileName, IntPtr securityAttributes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(SafeFileHandle file, byte[] buffer, uint numberOfBytesToWrite, out uint numberOfBytesWritten, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(SafeFileHandle file, byte[] buffer, uint numberOfBytesToRead, out uint numberOfBytesRead, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFilePointerEx(SafeFileHandle file, long distanceToMove, out long newFilePointer, uint moveMethod);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(SafeFileHandle file);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int fileInformationClass,
        IntPtr fileInformation,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        IntPtr fileInformation,
        uint bufferSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string fileName);

    internal byte[] Process(byte[] payload)
    {
        if (payload == null || payload.Length == 0)
        {
            return ColdCasHelperProtocol.Error("EMPTY_FRAME", "empty frame");
        }

        using (var stream = new MemoryStream(payload, false))
        using (var reader = new BinaryReader(stream, Encoding.UTF8, true))
        {
            var operation = reader.ReadByte();
            if (operation == ColdCasHelperProtocol.OpHello)
            {
                return Hello();
            }
            if (operation == ColdCasHelperProtocol.OpAllocate)
            {
                return Allocate(reader);
            }
            if (operation == ColdCasHelperProtocol.OpPublish)
            {
                return Publish(reader);
            }
            if (operation == ColdCasHelperProtocol.OpFinalize)
            {
                return FinalizePublish(reader);
            }
            if (operation == ColdCasHelperProtocol.OpCleanup)
            {
                return Cleanup(reader);
            }
            if (operation == ColdCasHelperProtocol.OpCancel)
            {
                return Cancel(reader);
            }
            if (operation == ColdCasHelperProtocol.OpShutdown)
            {
                return Shutdown(reader);
            }
            if (operation == ColdCasHelperProtocol.OpWrite)
            {
                return Write(reader);
            }
            if (operation == ColdCasHelperProtocol.OpSync)
            {
                return Sync(reader);
            }
            return ColdCasHelperProtocol.Error("UNKNOWN_OPERATION", "unknown helper operation");
        }
    }

    internal bool IsShutdown { get { return shutdown; } }

    private byte[] Hello()
    {
        if (sessionToken == null)
        {
            sessionToken = CreateToken();
        }
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream, Encoding.UTF8, true))
        {
            writer.Write(ColdCasHelperProtocol.ResponseHello);
            ColdCasHelperProtocol.WriteString(writer, sessionToken);
            writer.Flush();
            return stream.ToArray();
        }
    }

    private byte[] Allocate(BinaryReader reader)
    {
        var token = RequireSession(reader);
        var root = NormalizePath(ColdCasHelperProtocol.ReadString(reader));
        var finalPath = NormalizePath(ColdCasHelperProtocol.ReadString(reader));
        var hash = ColdCasHelperProtocol.ReadString(reader);
        ValidateHash(hash);
        var finalDirectory = NormalizePath(Path.GetDirectoryName(finalPath));
        ValidateUnderRoot(root, finalDirectory);
        ValidateFinalName(finalPath, hash);
        using (var leases = AcquireDirectoryLeases(root, finalDirectory))
        {
            var allocationToken = CreateToken();
            var tempPath = Path.Combine(finalDirectory, "." + hash + ".tmp-" + allocationToken);
            ValidateUnderRoot(root, tempPath);
            if (allocations.Count >= 128)
            {
                return ColdCasHelperProtocol.Error("TOO_MANY_ALLOCATIONS", "allocation limit reached");
            }
            var tempHandle = OpenFile(tempPath, GenericRead | DeleteAccess | FileReadAttributes | 0x40000000, FileShareRead, false, CreateNew);
            var allocation = new Allocation {
                Token = allocationToken,
                Root = root,
                FinalPath = finalPath,
                TempPath = tempPath,
                Hash = hash,
                PendingStatus = 0,
                Bytes = 0,
                TempHandle = tempHandle,
                Digest = SHA256.Create(),
                Synced = false,
            };
            allocations.Add(allocationToken, allocation);

            using (var stream = new MemoryStream())
            using (var writer = new BinaryWriter(stream, Encoding.UTF8, true))
            {
                writer.Write(ColdCasHelperProtocol.ResponseAllocated);
                ColdCasHelperProtocol.WriteString(writer, allocationToken);
                ColdCasHelperProtocol.WriteString(writer, tempPath);
                writer.Flush();
                return stream.ToArray();
            }
        }
    }

    private byte[] Publish(BinaryReader reader)
    {
        var session = RequireSession(reader);
        var allocationToken = ColdCasHelperProtocol.ReadString(reader);
        var expectedHash = ColdCasHelperProtocol.ReadString(reader);
        ValidateHash(expectedHash);
        Allocation allocation = RequireAllocation(allocationToken);
        if (!string.Equals(session, sessionToken, StringComparison.Ordinal) || !string.Equals(expectedHash, allocation.Hash, StringComparison.Ordinal) || allocation.TempHandle == null || !allocation.Synced)
        {
            return ColdCasHelperProtocol.Error("ALLOCATION_MISMATCH", "allocation binding mismatch");
        }

        using (var leases = AcquireDirectoryLeases(allocation.Root, Path.GetDirectoryName(allocation.FinalPath)))
        {
            var tempHandle = allocation.TempHandle;
            var tempBefore = ReadFileFacts(tempHandle);
            if (tempBefore.Directory || tempBefore.Reparse || tempBefore.NumberOfLinks != 1)
            {
                return MarkPendingFailure(allocation, "TEMP_IDENTITY_INVALID");
            }
            var hashBytes = allocation.Bytes;

            var finalBefore = TryReadExisting(allocation.FinalPath, allocation.Hash, 1, true, allocation.TempPath);
            if (finalBefore.Exists)
            {
                return PendingAllocation(allocation, finalBefore.Valid ? (byte)2 : (byte)3, hashBytes, finalBefore.Reason);
            }

            if (!CreateHardLinkW(allocation.FinalPath, allocation.TempPath, IntPtr.Zero))
            {
                var error = Marshal.GetLastWin32Error();
                if (error == ErrorAlreadyExists || error == ErrorFileExists)
                {
                    var raced = TryReadExisting(allocation.FinalPath, allocation.Hash, 1, true, allocation.TempPath);
                    return PendingAllocation(allocation, raced.Exists && raced.Valid ? (byte)2 : (byte)3, hashBytes, raced.Reason ?? "existing final failed strict validation");
                }
                return ColdCasHelperProtocol.Error("HARDLINK_FAILED", "handle link failed: " + Marshal.GetLastWin32Error().ToString());
            }

            var linkedFacts = ReadFileFacts(tempHandle);
            if (linkedFacts.Directory || linkedFacts.Reparse || linkedFacts.NumberOfLinks != 2 || linkedFacts.EndOfFile != tempBefore.EndOfFile)
            {
                return PendingAllocation(allocation, 3, hashBytes, "same-handle post-link facts failed");
            }
            var linkedFinal = TryReadExisting(allocation.FinalPath, allocation.Hash, 2);
            if (!linkedFinal.Exists || !linkedFinal.Valid)
            {
                return PendingAllocation(allocation, 3, hashBytes, linkedFinal.Reason ?? "linked final failed strict validation");
            }

            return PendingAllocation(allocation, 1, hashBytes, null);
        }
    }

    private byte[] FinalizePublish(BinaryReader reader)
    {
        RequireSession(reader);
        var token = ColdCasHelperProtocol.ReadString(reader);
        var allocation = RequireAllocation(token);
        if (allocation.PendingStatus == 0)
        {
            return ColdCasHelperProtocol.Error("NOT_PENDING", "allocation has no pending publication");
        }
        try
        {
            // Finalize must hold the complete non-reparse ancestor chain while
            // checking the temp name and final object; a path fallback is not
            // a valid substitute for this directory lease.
            using (var leases = AcquireDirectoryLeases(allocation.Root, Path.GetDirectoryName(allocation.FinalPath)))
            {
                if (PathExists(allocation.TempPath))
                {
                    // PendingAllocation has already closed the owned handle.
                    // Any name still present here is an unknown replacement
                    // and must remain untouched; dropping the helper
                    // allocation prevents a residual token from being
                    // mistaken for ownership of that entry.
                    allocations.Remove(token);
                    return ColdCasHelperProtocol.Error("TEMP_STILL_PRESENT", "temporary path is occupied by an unknown entry after the owned handle closed");
                }

                var status = allocation.PendingStatus;
                if (status == 3)
                {
                    var corruptFinal = TryReadExisting(allocation.FinalPath, allocation.Hash, 1);
                    if (!corruptFinal.Exists)
                    {
                        allocations.Remove(token);
                        return ColdCasHelperProtocol.Error("CORRUPT_FINAL_MISSING", "corrupt existing final disappeared before completion");
                    }
                    allocations.Remove(token);
                    return Complete(status, allocation.Bytes, allocation.CorruptReason ?? corruptFinal.Reason);
                }
                ExistingFacts finalFacts = null;
                for (var attempt = 0; attempt < 100; attempt++)
                {
                    finalFacts = TryReadExisting(allocation.FinalPath, allocation.Hash, 1);
                    if (finalFacts.Valid || !finalFacts.Exists)
                    {
                        break;
                    }
                    System.Threading.Thread.Sleep(10);
                }
                if (finalFacts == null)
                {
                    allocations.Remove(token);
                    return ColdCasHelperProtocol.Error("FINAL_VALIDATION_FAILED", "final validation produced no result");
                }
                if (status == 1 && (!finalFacts.Exists || !finalFacts.Valid))
                {
                    allocations.Remove(token);
                    return ColdCasHelperProtocol.Error("FINAL_VALIDATION_FAILED", finalFacts.Reason ?? "published final failed validation");
                }
                if (status == 2 && (!finalFacts.Exists || !finalFacts.Valid))
                {
                    allocations.Remove(token);
                    return ColdCasHelperProtocol.Error("REUSED_FINAL_CHANGED", finalFacts.Reason ?? "reused final changed");
                }
                allocations.Remove(token);
                return Complete(status, allocation.Bytes, allocation.CorruptReason);
            }
        }
        catch (Exception exception)
        {
            allocations.Remove(token);
            return ColdCasHelperProtocol.Error("FINAL_VALIDATION_FAILED", exception.Message);
        }
    }

    private byte[] Cleanup(BinaryReader reader)
    {
        RequireSession(reader);
        var token = ColdCasHelperProtocol.ReadString(reader);
        Allocation allocation = RequireAllocation(token);
        if (allocation.TempHandle == null)
        {
            if (allocation.PendingStatus != 0)
            {
                return BooleanResponse(false, "pending publication must be finalized before cleanup");
            }
            allocations.Remove(token);
            return BooleanResponse(true, string.Empty);
        }
        using (var leases = AcquireDirectoryLeases(allocation.Root, Path.GetDirectoryName(allocation.FinalPath)))
        {
            var tempHandle = allocation.TempHandle;
            var facts = ReadFileFacts(tempHandle);
            if (facts.Directory || facts.Reparse || facts.NumberOfLinks != 1)
            {
                return BooleanResponse(false, "owned temporary identity failed validation");
            }
            MarkDeletePending(tempHandle);
            tempHandle.Dispose();
            allocation.TempHandle = null;
            if (allocation.Digest != null)
            {
                allocation.Digest.Dispose();
            }
            allocation.Digest = null;
        }
        allocations.Remove(token);
        return BooleanResponse(true, string.Empty);
    }

    private byte[] Cancel(BinaryReader reader)
    {
        RequireSession(reader);
        var token = ColdCasHelperProtocol.ReadString(reader);
        Allocation allocation = RequireAllocation(token);
        if (allocation.TempHandle != null)
        {
            using (var leases = AcquireDirectoryLeases(allocation.Root, Path.GetDirectoryName(allocation.FinalPath)))
            {
                MarkDeletePending(allocation.TempHandle);
                allocation.TempHandle.Dispose();
                allocation.TempHandle = null;
                if (allocation.Digest != null)
                {
                    allocation.Digest.Dispose();
                }
                allocation.Digest = null;
            }
        }
        allocations.Remove(token);
        return BooleanResponse(true, string.Empty);
    }

    private byte[] Shutdown(BinaryReader reader)
    {
        RequireSession(reader);
        if (allocations.Count != 0)
        {
            return BooleanResponse(false, "outstanding allocation remains");
        }
        shutdown = true;
        return BooleanResponse(true, string.Empty);
    }

    private byte[] Write(BinaryReader reader)
    {
        RequireSession(reader);
        var token = ColdCasHelperProtocol.ReadString(reader);
        var allocation = RequireAllocation(token);
        if (allocation.TempHandle == null || allocation.Synced)
        {
            return BooleanResponse(false, "allocation is not writable");
        }
        var length = reader.ReadUInt16();
        if (length > 60 * 1024 || reader.BaseStream.Length - reader.BaseStream.Position != length)
        {
            return BooleanResponse(false, "write chunk exceeds the private frame bound");
        }
        var bytes = reader.ReadBytes(length);
        if (bytes.Length != length)
        {
            return BooleanResponse(false, "write chunk is truncated");
        }
        var totalWritten = 0;
        while (totalWritten < bytes.Length)
        {
            var remaining = new byte[bytes.Length - totalWritten];
            Buffer.BlockCopy(bytes, totalWritten, remaining, 0, remaining.Length);
            uint written;
            if (!WriteFile(allocation.TempHandle, remaining, (uint)remaining.Length, out written, IntPtr.Zero) || written == 0)
            {
                return BooleanResponse(false, "temporary write failed");
            }
            totalWritten += (int)written;
        }
        allocation.Digest.TransformBlock(bytes, 0, bytes.Length, null, 0);
        allocation.Bytes += (ulong)bytes.Length;
        return BooleanResponse(true, string.Empty);
    }

    private byte[] Sync(BinaryReader reader)
    {
        RequireSession(reader);
        var token = ColdCasHelperProtocol.ReadString(reader);
        var allocation = RequireAllocation(token);
        if (allocation.TempHandle == null || allocation.Synced)
        {
            return BooleanResponse(false, "allocation is not synchronizable");
        }
        if (!FlushFileBuffers(allocation.TempHandle))
        {
            return BooleanResponse(false, "temporary flush failed");
        }
        allocation.Digest.TransformFinalBlock(new byte[0], 0, 0);
        var hash = allocation.Digest.Hash;
        var builder = new StringBuilder(64);
        for (var index = 0; index < hash.Length; index++)
        {
            builder.Append(hash[index].ToString("x2"));
        }
        if (!string.Equals(builder.ToString(), allocation.Hash, StringComparison.Ordinal))
        {
            return ColdCasHelperProtocol.Error("HASH_MISMATCH", "temporary content does not match supplied identity");
        }
        allocation.Synced = true;
        return BooleanResponse(true, string.Empty);
    }

    private string RequireSession(BinaryReader reader)
    {
        var supplied = ColdCasHelperProtocol.ReadString(reader);
        if (sessionToken == null || !string.Equals(supplied, sessionToken, StringComparison.Ordinal))
        {
            throw new InvalidDataException("session token mismatch");
        }
        return supplied;
    }

    private Allocation RequireAllocation(string token)
    {
        Allocation allocation;
        if (token == null || !allocations.TryGetValue(token, out allocation))
        {
            throw new InvalidDataException("unknown allocation token");
        }
        return allocation;
    }

    private static byte[] Pending(Allocation allocation)
    {
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream, Encoding.UTF8, true))
        {
            writer.Write(ColdCasHelperProtocol.ResponsePending);
            writer.Write(allocation.PendingStatus);
            writer.Write(allocation.Bytes);
            ColdCasHelperProtocol.WriteString(writer, allocation.CorruptReason ?? string.Empty);
            writer.Flush();
            return stream.ToArray();
        }
    }

    private byte[] PendingAllocation(Allocation allocation, byte status, ulong bytes, string reason)
    {
        try
        {
            MarkDeletePending(allocation.TempHandle);
            allocation.TempHandle.Dispose();
            allocation.TempHandle = null;
            if (allocation.Digest != null)
            {
                allocation.Digest.Dispose();
                allocation.Digest = null;
            }
            allocation.PendingStatus = status;
            allocation.Bytes = bytes;
            allocation.CorruptReason = reason;
            return Pending(allocation);
        }
        catch (Exception exception)
        {
            return ColdCasHelperProtocol.Error("DELETE_DISPOSITION_FAILED", exception.Message);
        }
    }

    private static byte[] Complete(byte status, ulong bytes, string reason)
    {
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream, Encoding.UTF8, true))
        {
            writer.Write(ColdCasHelperProtocol.ResponseComplete);
            writer.Write(status);
            writer.Write(bytes);
            ColdCasHelperProtocol.WriteString(writer, reason ?? string.Empty);
            writer.Flush();
            return stream.ToArray();
        }
    }

    private static byte[] BooleanResponse(bool value, string reason)
    {
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream, Encoding.UTF8, true))
        {
            writer.Write(ColdCasHelperProtocol.ResponseBoolean);
            writer.Write(value);
            ColdCasHelperProtocol.WriteString(writer, reason ?? string.Empty);
            writer.Flush();
            return stream.ToArray();
        }
    }

    private static string CreateToken()
    {
        var bytes = new byte[32];
        using (var random = RandomNumberGenerator.Create())
        {
            random.GetBytes(bytes);
        }
        var builder = new StringBuilder(bytes.Length * 2);
        for (var index = 0; index < bytes.Length; index++)
        {
            builder.Append(bytes[index].ToString("x2"));
        }
        return builder.ToString();
    }

    private static string NormalizePath(string value)
    {
        if (string.IsNullOrEmpty(value) || value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
        {
            throw new InvalidDataException("path is empty or contains a forbidden character");
        }
        if (value.StartsWith("\\\\?\\", StringComparison.Ordinal))
        {
            throw new InvalidDataException("extended path syntax is not accepted");
        }
        var full = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (full.Length < 3 || full.IndexOf('*') >= 0 || full.IndexOf('?') >= 0)
        {
            throw new InvalidDataException("path is not a concrete absolute path");
        }
        return full;
    }

    private static void ValidateHash(string hash)
    {
        if (hash == null || hash.Length != 64)
        {
            throw new InvalidDataException("hash is not a strict SHA-256 identity");
        }
        for (var index = 0; index < hash.Length; index++)
        {
            var character = hash[index];
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
            {
                throw new InvalidDataException("hash is not lowercase hexadecimal");
            }
        }
    }

    private static void ValidateFinalName(string finalPath, string hash)
    {
        if (!string.Equals(Path.GetFileName(finalPath), hash, StringComparison.Ordinal))
        {
            throw new InvalidDataException("final name does not equal supplied hash");
        }
    }

    private static void ValidateUnderRoot(string root, string candidate)
    {
        var normalizedRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var normalizedCandidate = candidate.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!normalizedCandidate.Equals(normalizedRoot, StringComparison.OrdinalIgnoreCase) &&
            !normalizedCandidate.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("path escapes configured root");
        }
    }

    private sealed class DirectoryLeaseSet : IDisposable
    {
        private readonly List<SafeFileHandle> handles;

        internal DirectoryLeaseSet(List<SafeFileHandle> handles)
        {
            this.handles = handles;
        }

        internal SafeFileHandle Last
        {
            get { return handles[handles.Count - 1]; }
        }

        public void Dispose()
        {
            for (var index = handles.Count - 1; index >= 0; index--)
            {
                handles[index].Dispose();
            }
            handles.Clear();
        }
    }

    private static DirectoryLeaseSet AcquireDirectoryLeases(string root, string directory)
    {
        var leases = new List<SafeFileHandle>();
        try
        {
            var normalizedRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var normalizedDirectory = directory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            ValidateUnderRoot(normalizedRoot, normalizedDirectory);
            var relative = normalizedDirectory.Substring(normalizedRoot.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var current = normalizedRoot;
            leases.Add(OpenDirectory(current));
            if (relative.Length != 0)
            {
                var parts = relative.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
                for (var index = 0; index < parts.Length; index++)
                {
                    if (parts[index] == "." || parts[index] == ".." || parts[index].IndexOf(':') >= 0)
                    {
                        throw new InvalidDataException("unsafe directory segment");
                    }
                    current = Path.Combine(current, parts[index]);
                    leases.Add(OpenDirectory(current));
                }
            }
            return new DirectoryLeaseSet(leases);
        }
        catch
        {
            for (var index = leases.Count - 1; index >= 0; index--)
            {
                leases[index].Dispose();
            }
            throw;
        }
    }

    private static SafeFileHandle OpenDirectory(string path)
    {
        // Directory leases intentionally allow read/write sharing for the
        // hard-link and directory-metadata transition, but never delete
        // sharing. Object handles use the stricter read-only fence below.
        var handle = CreateFileW(path, FileReadAttributes | FileListDirectory | FileAddFile | Synchronize, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new IOException("directory open failed: " + error.ToString());
        }
        var facts = ReadFileFacts(handle);
        if (!facts.Directory || facts.Reparse)
        {
            handle.Dispose();
            throw new IOException("directory facts rejected: directory=" + facts.Directory.ToString() + ",reparse=" + facts.Reparse.ToString());
        }
        return handle;
    }

    private static SafeFileHandle OpenFile(string path, uint access, uint share, bool backupSemantics, uint creationDisposition = OpenExisting)
    {
        var flags = FileFlagOpenReparsePoint | (backupSemantics ? FileFlagBackupSemantics : 0);
        var handle = CreateFileW(path, access, share, IntPtr.Zero, creationDisposition, flags, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new IOException("file open failed: " + error.ToString());
        }
        return handle;
    }

    private static FileFacts ReadFileFacts(SafeFileHandle handle)
    {
        var standard = new FileStandardInfo();
        var attribute = new FileAttributeTagInfo();
        var standardPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileStandardInfo)));
        var attributePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileAttributeTagInfo)));
        try
        {
            if (!GetFileInformationByHandleEx(handle, FileStandardInfoClass, standardPointer, (uint)Marshal.SizeOf(typeof(FileStandardInfo))) ||
                !GetFileInformationByHandleEx(handle, FileAttributeTagInfoClass, attributePointer, (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo))))
            {
                throw new IOException("file facts query failed");
            }
            standard = (FileStandardInfo)Marshal.PtrToStructure(standardPointer, typeof(FileStandardInfo));
            attribute = (FileAttributeTagInfo)Marshal.PtrToStructure(attributePointer, typeof(FileAttributeTagInfo));
            return new FileFacts {
                EndOfFile = standard.EndOfFile < 0 ? 0UL : (ulong)standard.EndOfFile,
                NumberOfLinks = standard.NumberOfLinks,
                Directory = standard.Directory != 0,
                Reparse = (attribute.FileAttributes & FileAttributeReparsePoint) != 0,
            };
        }
        finally
        {
            Marshal.FreeHGlobal(standardPointer);
            Marshal.FreeHGlobal(attributePointer);
        }
    }

    private sealed class FileFacts
    {
        internal ulong EndOfFile;
        internal uint NumberOfLinks;
        internal bool Directory;
        internal bool Reparse;
    }

    private sealed class ExistingFacts
    {
        internal bool Exists;
        internal bool Valid;
        internal string Reason;
    }

    private static HashValue HashHandle(SafeFileHandle handle, ulong expectedBytes)
    {
        long pointer;
        if (!SetFilePointerEx(handle, 0, out pointer, FileBegin))
        {
            throw new IOException("same-handle seek failed: " + Marshal.GetLastWin32Error().ToString());
        }
        using (var digest = SHA256.Create())
        {
            var buffer = new byte[64 * 1024];
            ulong bytes = 0;
            while (bytes < expectedBytes)
            {
                var remaining = expectedBytes - bytes;
                var requested = (uint)Math.Min((ulong)buffer.Length, remaining);
                uint read;
                if (!ReadFile(handle, buffer, requested, out read, IntPtr.Zero))
                {
                    throw new IOException("same-handle read failed: " + Marshal.GetLastWin32Error().ToString());
                }
                if (read == 0)
                {
                    throw new IOException("same-handle read ended before stable size");
                }
                digest.TransformBlock(buffer, 0, (int)read, null, 0);
                bytes += (ulong)read;
            }
            digest.TransformFinalBlock(new byte[0], 0, 0);
            var result = new StringBuilder(64);
            var hash = digest.Hash;
            for (var index = 0; index < hash.Length; index++)
            {
                result.Append(hash[index].ToString("x2"));
            }
            return new HashValue { Hash = result.ToString(), Bytes = bytes };
        }
    }

    private sealed class HashValue
    {
        internal string Hash;
        internal ulong Bytes;
    }

    private static ExistingFacts TryReadExisting(string path, string expectedHash, uint expectedLinks = 1, bool allowInFlight = false, string ownTempPath = null)
    {
        if (!PathExists(path))
        {
            return new ExistingFacts { Exists = false, Valid = false, Reason = "final object does not exist" };
        }
        try
        {
            // The nlink=2 check is performed against this same handle. It
            // must never reopen with write sharing: an external writer
            // must be rejected while the helper-held temp identity is live.
            var share = FileShareRead;
            using (var handle = OpenFile(path, GenericRead | FileReadAttributes, share, false))
            {
                var beforeFacts = ReadFileFacts(handle);
                if (beforeFacts.Directory || beforeFacts.Reparse)
                {
                    return new ExistingFacts { Exists = true, Valid = false, Reason = "existing final failed regular/non-reparse validation" };
                }
                var actual = HashHandle(handle, beforeFacts.EndOfFile);
                var afterFacts = ReadFileFacts(handle);
                if (afterFacts.Directory || afterFacts.Reparse || afterFacts.EndOfFile != beforeFacts.EndOfFile || afterFacts.NumberOfLinks != beforeFacts.NumberOfLinks)
                {
                    return new ExistingFacts { Exists = true, Valid = false, Reason = "existing final changed during same-handle verification" };
                }
                if (!string.Equals(actual.Hash, expectedHash, StringComparison.Ordinal))
                {
                    return new ExistingFacts { Exists = true, Valid = false, Reason = "existing final hash differs from supplied content" };
                }
                if (afterFacts.NumberOfLinks != expectedLinks)
                {
                    if (allowInFlight && afterFacts.NumberOfLinks == 2 && ownTempPath != null && HasCompetingTemp(Path.GetDirectoryName(path), expectedHash, ownTempPath))
                    {
                        return new ExistingFacts { Exists = true, Valid = true, Reason = "matching final is in-flight" };
                    }
                    return new ExistingFacts { Exists = true, Valid = false, Reason = "existing final nlink did not match expected identity" };
                }
                return new ExistingFacts { Exists = true, Valid = true };
            }
        }
        catch (Exception exception)
        {
            return new ExistingFacts { Exists = true, Valid = false, Reason = "existing final inspection failed: " + exception.Message };
        }
    }

    private static bool HasCompetingTemp(string directory, string hash, string ownTempPath)
    {
        try
        {
            var prefix = "." + hash + ".tmp-";
            var entries = Directory.GetFileSystemEntries(directory, prefix + "*");
            for (var index = 0; index < entries.Length; index++)
            {
                var name = Path.GetFileName(entries[index]);
                if (name == null || string.Equals(entries[index], ownTempPath, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (!name.StartsWith(prefix, StringComparison.Ordinal) || !IsAllocationToken(name.Substring(prefix.Length)))
                {
                    continue;
                }
                var attributes = GetFileAttributesW(entries[index]);
                if (attributes != 0xFFFFFFFF && (attributes & (FileAttributeReparsePoint | FileAttributeDirectory)) == 0)
                {
                    return true;
                }
            }
        }
        catch
        {
            // An unverifiable competing temp is never treated as proof of an
            // in-flight winner. Unknown entries are never cleaned here.
            return false;
        }
        return false;
    }

    private static bool IsAllocationToken(string value)
    {
        if (value == null || value.Length != 64)
        {
            return false;
        }
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
            {
                return false;
            }
        }
        return true;
    }

    private static bool PathExists(string path)
    {
        var attributes = GetFileAttributesW(path);
        return attributes != 0xFFFFFFFF;
    }

    private static void MarkDeletePending(SafeFileHandle handle)
    {
        var extended = new FileDispositionInfoEx { Flags = FileDispositionFlagDelete };
        var extendedPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileDispositionInfoEx)));
        try
        {
            Marshal.StructureToPtr(extended, extendedPointer, false);
            if (SetFileInformationByHandle(handle, FileDispositionInfoExClass, extendedPointer, (uint)Marshal.SizeOf(typeof(FileDispositionInfoEx))) )
            {
                return;
            }
            var error = Marshal.GetLastWin32Error();
            if (error != ErrorInvalidParameter)
            {
                throw new IOException("delete disposition failed: " + error.ToString());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(extendedPointer);
        }

        var legacy = new FileDispositionInfo { DeleteRequested = true };
        var legacyPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileDispositionInfo)));
        try
        {
            Marshal.StructureToPtr(legacy, legacyPointer, false);
            if (!SetFileInformationByHandle(handle, FileDispositionInfoClass, legacyPointer, (uint)Marshal.SizeOf(typeof(FileDispositionInfo))))
            {
                throw new IOException("legacy delete disposition failed: " + Marshal.GetLastWin32Error().ToString());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(legacyPointer);
        }
    }

    private static byte[] MarkPendingFailure(Allocation allocation, string reason)
    {
        allocation.PendingStatus = 3;
        allocation.CorruptReason = reason;
        return ColdCasHelperProtocol.Error("TEMP_IDENTITY_INVALID", reason);
    }
}

internal static class Program
{
    private static int Main()
    {
        var helper = new ColdCasHelper();
        using (var input = Console.OpenStandardInput())
        using (var output = Console.OpenStandardOutput())
        {
            try
            {
                while (!helper.IsShutdown)
                {
                    byte[] request;
                    try
                    {
                        request = ColdCasHelperProtocol.ReadFrame(input);
                    }
                    catch (Exception exception)
                    {
                        ColdCasHelperProtocol.WriteFrame(output, ColdCasHelperProtocol.Error("PROTOCOL_ERROR", exception.Message));
                        return 2;
                    }
                    if (request == null)
                    {
                        return 0;
                    }

                    byte[] response;
                    try
                    {
                        response = helper.Process(request);
                    }
                    catch (Exception exception)
                    {
                        response = ColdCasHelperProtocol.Error("HELPER_FAILURE", exception.Message);
                    }
                    ColdCasHelperProtocol.WriteFrame(output, response);
                }
                return 0;
            }
            catch
            {
                return 3;
            }
        }
    }
}
