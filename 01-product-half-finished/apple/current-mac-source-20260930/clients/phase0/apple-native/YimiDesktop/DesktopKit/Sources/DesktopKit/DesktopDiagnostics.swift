import os

/// Shared by the MCP host and its byte transport. Never log request or reply payloads.
public enum DesktopDiagnostics {
    public static let logger = Logger(subsystem: "ai.paios.personal.desktop", category: "desktop")
}
