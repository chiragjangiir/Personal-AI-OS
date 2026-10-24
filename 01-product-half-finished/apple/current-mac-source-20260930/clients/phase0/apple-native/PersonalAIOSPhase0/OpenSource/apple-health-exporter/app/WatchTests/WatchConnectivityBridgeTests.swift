import Foundation
import XCTest
@testable import PersonalAIOSWatch

final class WatchConnectivityBridgeTestsWatch: XCTestCase {
    func testSharedLegacyPacketsRemainDecodable() throws {
        let voice = WatchAssistantPacket(
            action: .requestVoiceSession,
            requestID: "voice",
            sequence: 1
        )
        let stop = WatchAssistantPacket(
            action: .stopCurrentSession,
            requestID: "stop",
            sequence: 2
        )
        XCTAssertEqual(
            try WatchAssistantPacket.decodeStrict(voice.encodedStrict()),
            voice
        )
        XCTAssertEqual(
            try WatchAssistantPacket.decodeStrict(stop.encodedStrict()),
            stop
        )
    }
}

