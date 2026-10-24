import Darwin
import Foundation

/// Same-user IPC between the SSH command and the app. No TCP listener or status cache.
public final class AndroidControlSocket: @unchecked Sendable {
    private let source: DispatchSourceRead
    private let lease: Int32
    private let path: String
    public init(directory: URL, handle: @escaping @Sendable (String) async throws -> Data) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        path = directory.appendingPathComponent("control.sock").path
        lease = open(directory.appendingPathComponent("control.lock").path, O_CREAT | O_RDWR, 0o600)
        guard lease >= 0 else { throw POSIXError(.EIO) }
        guard flock(lease, LOCK_EX | LOCK_NB) == 0 else { close(lease); throw POSIXError(.EADDRINUSE) }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        do {
            var address = try Self.address(path)
            if unlink(path) != 0 && errno != ENOENT { throw POSIXError(POSIXErrorCode(rawValue: errno)!) }
            let bound = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard bound == 0, chmod(path, 0o600) == 0, listen(descriptor, 4) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno)!) }
        } catch { close(descriptor); close(lease); throw error }
        source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: DispatchQueue(label: "yimi.android.control"))
        source.setCancelHandler { close(descriptor) }
        source.setEventHandler {
            let peer = accept(descriptor, nil, nil)
            guard peer >= 0 else { return }
            Self.configure(peer)
            var request = Data(), byte: UInt8 = 0
            while request.count < 16 && recv(peer, &byte, 1, 0) == 1 {
                if byte == 10 { break }; request.append(byte)
            }
            let action = String(decoding: request, as: UTF8.self)
            Task {
                let file = FileHandle(fileDescriptor: peer, closeOnDealloc: true)
                do {
                    guard ["status", "start"].contains(action) else { throw POSIXError(.EINVAL) }
                    let response: Data
                    do { response = try await handle(action) }
                    catch { response = try JSONSerialization.data(withJSONObject: ["error": error.localizedDescription]) }
                    try file.write(contentsOf: response + Data([10]))
                } catch { NSLog("Android control: %@", error.localizedDescription) }
            }
        }
        source.resume()
    }
    deinit { source.cancel(); unlink(path); close(lease) }
    public static func request(_ action: String, directory: URL) throws -> Data {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        configure(descriptor)
        var address = try address(directory.appendingPathComponent("control.sock").path)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno)!) }
        try file.write(contentsOf: Data((action + "\n").utf8))
        shutdown(descriptor, SHUT_WR)
        return try file.readToEnd() ?? Data()
    }
    private static func address(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array(path.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw POSIXError(.ENAMETOOLONG) }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        return address
    }
    private static func configure(_ descriptor: Int32) {
        var timeout = timeval(tv_sec: 5, tv_usec: 0), yes: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
    }
}
