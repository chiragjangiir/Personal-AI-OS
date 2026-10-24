import Foundation

@main enum AndroidControl {
    static func main() {
        do {
            guard CommandLine.arguments.count == 2, ["status", "start"].contains(CommandLine.arguments[1]) else {
                throw POSIXError(.EINVAL)
            }
            let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Yimi/Android")
            let data = try AndroidControlSocket.request(CommandLine.arguments[1], directory: directory)
            let response = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            if let error = response?["error"] as? String { throw NSError(domain: "YimiAndroid", code: 1, userInfo: [NSLocalizedDescriptionKey: error]) }
            guard response?["schema"] as? String == "paios.mac-android.v1" else { throw CocoaError(.fileReadCorruptFile) }
            try FileHandle.standardOutput.write(contentsOf: data)
        } catch { fputs("手机执行器不在线：\(error.localizedDescription)\n", stderr); exit(1) }
    }
}
