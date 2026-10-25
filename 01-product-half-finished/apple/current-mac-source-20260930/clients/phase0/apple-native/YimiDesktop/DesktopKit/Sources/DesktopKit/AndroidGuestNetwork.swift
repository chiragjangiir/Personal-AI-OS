import Foundation
import CFNetwork

/// The persistent Redroid guest uses Lima's Ethernet route to the product's mainland proxy.
struct AndroidGuestNetwork {
    static let proxyPort: UInt16 = 18080
    static let guestProxy = "192.168.5.2:18080"
    let device: AndroidVirtualDevice
    let processes: any AndroidProcessRunning

    static func downloadProxyConfiguration() throws -> String {
        let settings = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any]
        guard (settings?[kCFNetworkProxiesHTTPSEnable as String] as? NSNumber)?.boolValue == true else { return "" }
        guard let host = settings?[kCFNetworkProxiesHTTPSProxy as String] as? String,
              let port = settings?[kCFNetworkProxiesHTTPSPort as String] as? Int else {
            throw AndroidHostError.unavailable("系统下载代理配置不完整")
        }
        var proxy = URLComponents(); proxy.scheme = "http"; proxy.port = port
        proxy.host = ["127.0.0.1", "localhost", "::1"].contains(host) ? "192.168.5.2" : host
        guard let url = proxy.url?.absoluteString else { throw AndroidHostError.unavailable("系统下载代理地址无效") }
        let config = ["proxies": ["http-proxy": url, "https-proxy": url, "no-proxy": "localhost,127.0.0.1"]]
        return String(decoding: try JSONSerialization.data(withJSONObject: config, options: [.withoutEscapingSlashes]), as: UTF8.self)
    }

    static func createConfiguration(device: AndroidVirtualDevice) throws {
        // JSON is valid YAML; encoding preserves the configured physical interface literally.
        let config: [String: Any] = ["services": [["name": "http-direct", "addr": "127.0.0.1:18080",
            "interface": device.physicalInterface, "resolver": "cn-dns", "handler": ["type": "http"],
            "listener": ["type": "tcp"]]], "resolvers": [["name": "cn-dns", "nameservers": [
                ["addr": "udp://223.5.5.5:53"], ["addr": "udp://119.29.29.29:53"]]]]]
        try JSONSerialization.data(withJSONObject: config, options: [.withoutEscapingSlashes]).write(to: device.file("gost.yml"), options: .atomic)
    }

    func prepare() async throws {
        _ = try await processes.output(device.lima(["shell", device.instance, "--", "sudo", "modprobe", "-a", "ipt_REJECT", "ip6t_REJECT"]), timeout: .seconds(15))
        _ = try await processes.output(device.lima(["shell", device.instance, "--", "sudo", "docker", "exec", "--user", "0", "redroid", "sh", "-c", Self.udpRules]), timeout: .seconds(15))
        _ = try await processes.output(device.adb(["shell", "set -e\nsettings put global http_proxy \(Self.guestProxy)\n" + Self.captivePortals]), timeout: .seconds(15))
        try await verify()
    }

    func verify() async throws {
        let status = try await processes.output(device.adb(["shell", Self.connectivity]), timeout: .seconds(15))
        guard Self.healthy(status) else {
            throw AndroidHostError.unavailable("安卓手机还没联网：网络或代理尚未就绪。")
        }
    }

    static func healthy(_ status: String) -> Bool {
        let lines = status.split(whereSeparator: \.isNewline)
        return lines.contains("redroid-ethernet-ready") && lines.contains { line in
            let columns = line.split(separator: " ")
            return columns.count >= 2 && columns[0].hasPrefix("HTTP/") && columns[1] == "204"
        }
    }

    // Check the actual guest route and proxy response instead of emulator Wi-Fi validation.
    static let connectivity = """
    set -e
    [ "$(settings get global http_proxy)" = "192.168.5.2:18080" ]
    ip -4 route get 192.168.5.2 | grep -q ' dev eth0 '
    echo redroid-ethernet-ready
    printf 'GET http://www.google.cn/generate_204 HTTP/1.1\\r\\nHost: www.google.cn\\r\\nConnection: close\\r\\n\\r\\n' | nc -w 10 192.168.5.2 18080
    """

    static let udpRules = """
    set -e
    for tool in iptables ip6tables; do
      if ! $tool -w -C OUTPUT ! -o lo -p udp ! --dport 53 -j REJECT 2>/dev/null; then
        $tool -w -I OUTPUT 1 ! -o lo -p udp ! --dport 53 -j REJECT
      fi
    done
    """

    // Keep existing custom captive-portal settings visible rather than silently replacing them.
    static let captivePortals = """
    set -e
    ensure_url() {
      current=$(settings get global "$1")
      if [ "$current" = null ] || [ -z "$current" ]; then
        settings put global "$1" "$2"
      fi
      [ "$(settings get global "$1")" = "$2" ] || { echo "Unexpected captive portal URL: $1" >&2; exit 1; }
    }
    ensure_url captive_portal_https_url https://www.google.cn/generate_204
    ensure_url captive_portal_http_url http://www.google.cn/generate_204
    ensure_url captive_portal_fallback_url http://connect.rom.miui.com/generate_204
    """
}
