import Foundation

/// Uses the executor's APK catalog and the guest package manager; keeps no second installation registry.
public struct AndroidPhoneProvisioner: Sendable {
    private struct App: Decodable {
        let package: String, url: URL, sha256: String
        let version_code: Int
        let archive_path: String?
        let archive_sha256: String?
    }
    private let device: AndroidVirtualDevice
    private let processes: any AndroidProcessRunning
    private let catalog: URL, archives: URL?
    private let session: URLSession
    public init(device: AndroidVirtualDevice, processes: any AndroidProcessRunning, catalog: URL, archives: URL? = nil, session: URLSession = .shared) {
        self.device = device; self.processes = processes; self.catalog = catalog; self.archives = archives; self.session = session
    }
    public func installMissing(packages: Set<String>? = nil) async throws {
        let apps = try JSONDecoder().decode([App].self, from: Data(contentsOf: catalog))
        let output = try await processes.output(device.adb(["shell", "pm", "list", "packages", "--show-versioncode"]), timeout: .seconds(15))
        var versions: [String: Int] = [:]
        for line in output.split(separator: "\n") {
            let columns = line.split(whereSeparator: \.isWhitespace)
            guard columns.count == 2, columns[0].hasPrefix("package:"), columns[1].hasPrefix("versionCode:"),
                  let version = Int(columns[1].dropFirst(12)) else { throw CocoaError(.fileReadCorruptFile) }
            versions[String(columns[0].dropFirst(8))] = version
        }
        for app in apps where packages?.contains(app.package) ?? true {
            try Task.checkCancellation()
            // The owner keeps the installed Qwen and its login, including older versions.
            if app.package == "com.aliyun.tongyi", versions[app.package] != nil { continue }
            if let version = versions[app.package], version >= app.version_code { continue }
            try await install(app)
        }
    }
    /// Called only for a fresh installation, before the host becomes available to the executor.
    public func prepareExecutor() async throws {
        _ = try await processes.output(device.adb(["shell", Self.executorSetup]), timeout: .seconds(20))
    }
    static let executorSetup = """
    set -e
    service=com.mobilerun.portal/com.mobilerun.portal.service.MobilerunAccessibilityService
    current=$(settings get secure enabled_accessibility_services)
    case ":$current:" in
      *":$service:"*) ;;
      *)
        if [ "$current" = null ] || [ -z "$current" ]; then current=$service; else current="$current:$service"; fi
        settings put secure enabled_accessibility_services "$current"
        ;;
    esac
    settings put secure accessibility_enabled 1
    ime enable com.mobilerun.portal/.input.MobilerunKeyboardIME
    ime list -s | grep -Fx com.mobilerun.portal/.input.MobilerunKeyboardIME
    pm grant io.appium.settings android.permission.ACCESS_COARSE_LOCATION
    pm grant io.appium.settings android.permission.ACCESS_FINE_LOCATION
    appops set io.appium.settings android:mock_location allow
    appops get io.appium.settings android:mock_location | grep -q allow
    """
    private func install(_ app: App) async throws {
        let fm = FileManager.default, work = device.file(".phone-app-" + UUID().uuidString)
        try fm.createDirectory(at: work, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: work) }
        let download: URL
        if let archives { download = archives.appendingPathComponent(app.url.lastPathComponent) }
        else {
            let (temporary, response) = try await session.download(from: app.url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.url?.scheme == "https" else { throw URLError(.badServerResponse) }
            download = work.appendingPathComponent(app.archive_path == nil ? "app.apk" : "download")
            try fm.moveItem(at: temporary, to: download)
        }
        let apk: URL
        if let member = app.archive_path {
            guard let digest = app.archive_sha256 else {
                throw AndroidHostError.unavailable("手机 App 的外层压缩包缺少 SHA-256：\(app.package)")
            }
            try AndroidArtifact.verify(download, size: nil, checksum: digest, algorithm: .sha256, name: app.package + " archive")
            let extracted = work.appendingPathComponent("extracted")
            try fm.createDirectory(at: extracted, withIntermediateDirectories: true)
            _ = try await processes.output(AndroidCommand(URL(fileURLWithPath: "/usr/bin/tar"), ["-xf", download.path, "-C", extracted.path, member]), timeout: .seconds(30))
            apk = extracted.appendingPathComponent(member)
        } else { apk = download }
        try AndroidArtifact.verify(apk, size: nil, checksum: app.sha256, algorithm: .sha256, name: app.package)
        let result = try await processes.output(device.adb(["install", "-r", apk.path]), timeout: .seconds(120))
        guard result.split(whereSeparator: \.isNewline).last == "Success" else {
            throw AndroidHostError.unavailable("手机 App 安装失败：\(app.package)：\(result)")
        }
    }
}
