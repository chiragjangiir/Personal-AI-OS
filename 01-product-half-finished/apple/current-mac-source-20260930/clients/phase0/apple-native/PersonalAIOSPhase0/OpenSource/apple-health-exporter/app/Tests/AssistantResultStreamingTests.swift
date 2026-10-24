import XCTest
@testable import HealthKitExporter

final class AssistantResultStreamingTests: XCTestCase {
    func testPartialThenFinalUpdatesSnapshot() async {
        let reducer = AssistantResultStreamReducer()
        let partial = AssistantResultEnvelope(
            streamID: "stream-1",
            sequence: 1,
            text: "partial",
            isFinal: false,
            sessionID: "session-1",
            epoch: 1
        )
        let final = AssistantResultEnvelope(
            streamID: "stream-1",
            sequence: 2,
            text: "final",
            isFinal: true,
            sessionID: "session-1",
            epoch: 1
        )

        let first = await reducer.accept(partial)
        let second = await reducer.accept(final)
        let snapshot = await reducer.snapshot()

        XCTAssertEqual(first, .acceptedPartial)
        XCTAssertEqual(second, .acceptedFinal)
        XCTAssertEqual(snapshot.text, "final")
        XCTAssertTrue(snapshot.isFinal)
        XCTAssertEqual(snapshot.epoch, 1)
    }

    func testFinalRejectsPartialAndOldStream() async {
        let reducer = AssistantResultStreamReducer()
        _ = await reducer.accept(
            AssistantResultEnvelope(
                streamID: "stream-1",
                sequence: 1,
                text: "final",
                isFinal: true,
                sessionID: "session-1",
                epoch: 1
            )
        )

        let partialAfterFinal = await reducer.accept(
            AssistantResultEnvelope(
                streamID: "stream-1",
                sequence: 2,
                text: "reopened",
                isFinal: false,
                sessionID: "session-1",
                epoch: 1
            )
        )
        let oldStream = await reducer.accept(
            AssistantResultEnvelope(
                streamID: "old-stream",
                sequence: 3,
                text: "old",
                isFinal: false,
                sessionID: "session-1",
                epoch: 1
            )
        )
        let duplicate = await reducer.accept(
            AssistantResultEnvelope(
                streamID: "stream-1",
                sequence: 1,
                text: "final",
                isFinal: true,
                sessionID: "session-1",
                epoch: 1
            )
        )

        XCTAssertEqual(partialAfterFinal, .stale)
        XCTAssertEqual(oldStream, .acceptedPartial)
        XCTAssertEqual(duplicate, .duplicateFinal)
    }

    func testHigherEpochIsTheOnlyNewStreamFence() async {
        let reducer = AssistantResultStreamReducer()
        _ = await reducer.accept(
            AssistantResultEnvelope(
                streamID: "stream-1",
                sequence: 1,
                text: "first",
                isFinal: true,
                sessionID: "session-1",
                epoch: 1
            )
        )

        let sameEpoch = await reducer.accept(
            AssistantResultEnvelope(
                streamID: "stream-2",
                sequence: 1,
                text: "wrong fence",
                isFinal: false,
                sessionID: "session-1",
                epoch: 1
            )
        )
        let nextEpoch = await reducer.accept(
            AssistantResultEnvelope(
                streamID: "stream-2",
                sequence: 1,
                text: "second",
                isFinal: false,
                sessionID: "session-2",
                epoch: 2
            )
        )

        XCTAssertEqual(sameEpoch, .acceptedPartial)
        XCTAssertEqual(nextEpoch, .acceptedPartial)
    }

    func testTwoPromptStreamsCanCompleteOutOfOrderInOneEpoch() async {
        let reducer = AssistantResultStreamReducer()
        let firstPartial = AssistantResultEnvelope(
            streamID: "prompt-1",
            sequence: 1,
            text: "one",
            isFinal: false,
            sessionID: "session-1",
            epoch: 1
        )
        let secondPartial = AssistantResultEnvelope(
            streamID: "prompt-2",
            sequence: 1,
            text: "two",
            isFinal: false,
            sessionID: "session-1",
            epoch: 1
        )
        let secondFinal = AssistantResultEnvelope(
            streamID: "prompt-2",
            sequence: 2,
            text: "two final",
            isFinal: true,
            sessionID: "session-1",
            epoch: 1
        )
        let firstFinal = AssistantResultEnvelope(
            streamID: "prompt-1",
            sequence: 2,
            text: "one final",
            isFinal: true,
            sessionID: "session-1",
            epoch: 1
        )

        let firstPartialDecision = await reducer.accept(firstPartial)
        let secondPartialDecision = await reducer.accept(secondPartial)
        let secondFinalDecision = await reducer.accept(secondFinal)
        let firstFinalDecision = await reducer.accept(firstFinal)
        XCTAssertEqual(firstPartialDecision, .acceptedPartial)
        XCTAssertEqual(secondPartialDecision, .acceptedPartial)
        XCTAssertEqual(secondFinalDecision, .acceptedFinal)
        XCTAssertEqual(firstFinalDecision, .acceptedFinal)
        let snapshot = await reducer.snapshot()
        XCTAssertEqual(snapshot.streamID, "prompt-1")
        XCTAssertEqual(snapshot.text, "one final")
        XCTAssertTrue(snapshot.isFinal)
    }

    func testErrorFinalIsWellFormedAndDoesNotBecomeModelText() async {
        let reducer = AssistantResultStreamReducer()
        let error = AssistantResultEnvelope(
            streamID: "prompt-1",
            sequence: 1,
            text: "",
            isFinal: true,
            sessionID: "session-1",
            epoch: 1,
            errorCode: "MODEL_UNAVAILABLE"
        )

        let decision = await reducer.accept(error)
        XCTAssertEqual(decision, .acceptedFinal)
        let snapshot = await reducer.snapshot()
        XCTAssertEqual(snapshot.text, "")
        XCTAssertTrue(snapshot.isFinal)
    }

    func testResetFencesLateFramesFromPriorSession() async {
        let reducer = AssistantResultStreamReducer()
        await reducer.reset()
        let first = AssistantResultEnvelope(
            streamID: "stream-1",
            sequence: 1,
            text: "first",
            isFinal: true,
            sessionID: "session-1",
            epoch: 1
        )
        let firstDecision = await reducer.accept(first)
        XCTAssertEqual(firstDecision, .acceptedFinal)

        await reducer.reset()
        let late = AssistantResultEnvelope(
            streamID: "stream-1",
            sequence: 2,
            text: "late",
            isFinal: false,
            sessionID: "session-1",
            epoch: 1
        )
        let next = AssistantResultEnvelope(
            streamID: "stream-2",
            sequence: 1,
            text: "next",
            isFinal: false,
            sessionID: "session-2",
            epoch: 2
        )
        let lateDecision = await reducer.accept(late)
        let nextDecision = await reducer.accept(next)
        XCTAssertEqual(lateDecision, .stale)
        XCTAssertEqual(nextDecision, .acceptedPartial)
    }

}
