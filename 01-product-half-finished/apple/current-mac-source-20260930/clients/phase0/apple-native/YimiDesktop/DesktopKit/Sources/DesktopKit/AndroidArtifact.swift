import CryptoKit
import Foundation

public struct AndroidArtifact: Sendable {
    public enum Checksum: Equatable, Sendable { case sha1, sha256 }
    public let url: URL, size: Int64, checksum: String
    public let algorithm: Checksum
    public let destination: String, unpacked: String, required: String
    public init(url: URL, size: Int64, checksum: String, algorithm: Checksum, destination: String, unpacked: String, required: String) {
        self.url = url; self.size = size; self.checksum = checksum
        self.algorithm = algorithm
        self.destination = destination; self.unpacked = unpacked; self.required = required
    }
    public static let runtime: [AndroidArtifact] = [
        AndroidArtifact(url: URL(string: "https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz")!,
            size: 38328082, checksum: "9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e", algorithm: .sha256,
            destination: "tools/lima", unpacked: "", required: "tools/lima/bin/limactl"),
        AndroidArtifact(url: URL(string: "https://dl.google.com/android/repository/platform-tools_r37.0.1-darwin.zip")!,
            size: 16110554, checksum: "ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d", algorithm: .sha256,
            destination: "sdk/platform-tools", unpacked: "platform-tools", required: "sdk/platform-tools/adb"),
        AndroidArtifact(url: URL(string: "https://github.com/go-gost/gost/releases/download/v3.3.0/gost_3.3.0_darwin_arm64.tar.gz")!,
            size: 15846910, checksum: "f170226106844b50ab3435147f35d4300da773efca256b50cb2f8c7d3a151101", algorithm: .sha256,
            destination: "tools/gost", unpacked: "", required: "tools/gost/gost")
    ]
    public static let ubuntu = AndroidArtifact(
        url: URL(string: "https://cloud-images.ubuntu.com/minimal/releases/noble/release-20261017/ubuntu-24.04-minimal-cloudimg-arm64.img")!,
        size: 223936512, checksum: "11378ad399741da3884b4343a9b06c1a1bb3d8cb71e309a4a11cadc2b516d0f9", algorithm: .sha256,
        destination: "cache", unpacked: "", required: "cache/ubuntu-24.04-minimal-cloudimg-arm64.img")
    public static let scrcpy = AndroidArtifact(
        url: URL(string: "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-macos-aarch64-v5.0.1.tar.gz")!,
        size: 12565912, checksum: "33611e51977a8289e2e124b220f727895181ef2eb9060e0987a4dc2db9cf0d6b", algorithm: .sha256,
        destination: "tools/scrcpy", unpacked: "scrcpy-macos-aarch64-v5.0.1", required: "tools/scrcpy/scrcpy")

    public func verify(_ archive: URL) throws {
        try Self.verify(archive, size: size, checksum: checksum, algorithm: algorithm, name: url.lastPathComponent)
    }
    public static func verify(_ archive: URL, size: Int64?, checksum: String, algorithm: Checksum, name: String) throws {
        let handle = try FileHandle(forReadingFrom: archive); defer { try? handle.close() }
        var sha1 = Insecure.SHA1(), sha256 = SHA256(), count: Int64 = 0
        while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty {
            try Task.checkCancellation()
            count += Int64(data.count)
            if algorithm == .sha1 { sha1.update(data: data) } else { sha256.update(data: data) }
        }
        let bytes = algorithm == .sha1 ? Array(sha1.finalize()) : Array(sha256.finalize())
        let digest = bytes.map { String(format: "%02x", $0) }.joined()
        guard size == nil || count == size, digest == checksum else { throw AndroidHostError.verification(name) }
    }
}
