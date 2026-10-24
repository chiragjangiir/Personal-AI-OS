import Foundation
import Darwin
import XCTest
@testable import HealthKitExporter

final class AssistantCompositionTests: XCTestCase {
#if DEBUG
    func testDebugEnrollmentPresentationIsNeverBlank() {
        let messages = [
            PAIOSDebugPairingPresentation.title,
            PAIOSDebugPairingPresentation.exportSucceeded,
            PAIOSDebugPairingPresentation.exportFailed,
            PAIOSDebugPairingPresentation.supportDirectoryUnavailable,
            PAIOSDebugPairingPresentation.importSucceeded,
            PAIOSDebugPairingPresentation.importRejected,
            PAIOSDebugPairingPresentation.importUnavailable
        ]
        XCTAssertTrue(messages.allSatisfy { !$0.trimmingCharacters(
            in: .whitespacesAndNewlines
        ).isEmpty })
    }

    func testDebugPhysicalProductionLaunchRequiresReadyPersistedEnrollment() {
        let cases: [
            (
                RealtimePairingImportResult?,
                Bool,
                Bool,
                Bool
            )
        ] = [
            (.imported, true, true, true),
            (.absent, true, true, true),
            (.rejected, true, true, false),
            (.imported, false, true, false),
            (.absent, false, true, false),
            (.imported, true, false, false),
            (nil, true, true, false)
        ]

        for (result, providerReady, startRequested, expected) in cases {
            XCTAssertEqual(
                PAIOSDebugPhysicalProductionLaunch.shouldPrepareEndpoint(
                    importResult: result,
                    providerReady: providerReady,
                    startOnceRequested: startRequested
                ),
                expected
            )
        }
    }

    func testDebugPhysicalProductionLaunchRetriesAfterForegroundOnlyForFailedSession() {
        let cases: [(Bool, Bool, AssistantSessionState, Bool)] = [
            (true, false, .failed(code: "start_failed"), true),
            (true, true, .failed(code: "start_failed"), false),
            (false, false, .failed(code: "start_failed"), false),
            (true, false, .idle, false),
            (true, false, .active(encryptionActive: false), false),
            (true, false, .stopped(remoteStopConfirmed: false), false)
        ]

        for (startOnceRequested, recoveryAttempted, sessionState, expected) in cases {
            XCTAssertEqual(
                PAIOSDebugPhysicalProductionLaunch.shouldRetryAfterForeground(
                    startOnceRequested: startOnceRequested,
                    recoveryAttempted: recoveryAttempted,
                    sessionState: sessionState
                ),
                expected
            )
        }
    }

    @MainActor
    func testDebugPhysicalAbsentEnrollmentPreparesEndpointBeforeStart()
        async {
        let preparation = PAIOSDebugPhysicalEndpointPreparationOnce()
        var savedSettings: [AppSettings] = []
        var prepared = false
        let preparationResult = await preparation.run(
            importResult: .absent,
            providerReady: true,
            pairingOrigin: "https://api.example:9443",
            saveSettings: { settings in
                savedSettings.append(settings)
            },
            onPrepared: {
                prepared = true
            }
        )

        let runner = PAIOSDebugProductionStartOnce()
        var startedAfterPreparation = false
        let marker = await runner.run(
            importResult: .absent,
            providerReady: true
        ) {
            startedAfterPreparation = prepared
            return true
        }

        XCTAssertEqual(preparationResult, true)
        XCTAssertTrue(startedAfterPreparation)
        XCTAssertEqual(marker, .active)
        XCTAssertEqual(
            savedSettings,
            [
                AppSettings(
                    endpoint: "https://api.example:9443"
                )
            ]
        )
    }

    @MainActor
    func testDebugPhysicalBundleLaunchStartsImportedBundleOnce() async {
        let supportURL = URL(fileURLWithPath: "/tmp/paios-launch-bridge")
        let bundleURL = supportURL.appendingPathComponent(
            RealtimeDevicePairingRuntime.pairingRelativePath
        )
        var checkedURL: URL?
        let autoImportRequested =
            PAIOSDebugPairingLaunch.shouldAutoImportPairing(
                arguments: ["PersonalAIOSPhase0"],
                isPhysicalDevice: true,
                applicationSupportURL: supportURL,
                fileExists: { url in
                    checkedURL = url
                    return url == bundleURL
                }
            )

        XCTAssertTrue(autoImportRequested)
        XCTAssertEqual(checkedURL, bundleURL)

        let runner = PAIOSDebugProductionStartOnce()
        var calls = 0
        let first = await runner.run(
            importResult: .imported,
            providerReady: true
        ) {
            calls += 1
            return true
        }
        let second = await runner.run(
            importResult: .imported,
            providerReady: true
        ) {
            calls += 1
            return true
        }

        XCTAssertEqual(first, .active)
        XCTAssertNil(second)
        XCTAssertEqual(calls, 1)
    }

    @MainActor
    func testDebugPhysicalAutoImportSelectsEndpointPreparationPath() async {
        let supportURL = URL(fileURLWithPath: "/tmp/paios-launch-bridge")
        let autoImportRequested =
            PAIOSDebugPairingLaunch.shouldAutoImportPairing(
                arguments: ["PersonalAIOSPhase0"],
                isPhysicalDevice: true,
                applicationSupportURL: supportURL,
                fileExists: { _ in true }
            )

        let preparation = PAIOSDebugPhysicalEndpointPreparationOnce()
        var preparedCallbacks = 0
        let prepared = await preparation.run(
            importResult: autoImportRequested ? .imported : .absent,
            providerReady: autoImportRequested,
            pairingOrigin: "https://api.example:9443",
            saveSettings: { _ in },
            onPrepared: {
                preparedCallbacks += 1
            }
        )

        XCTAssertTrue(autoImportRequested)
        XCTAssertEqual(prepared, true)
        XCTAssertEqual(preparedCallbacks, 1)
    }

    @MainActor
    func testDebugPhysicalEndpointPreparationWritesExactOriginAndStartsOnce()
        async {
        let preparation = PAIOSDebugPhysicalEndpointPreparationOnce()
        var savedSettings: [AppSettings] = []
        var preparedCallbacks = 0
        let prepared = await preparation.run(
            importResult: .imported,
            providerReady: true,
            pairingOrigin: "https://api.example:9443",
            saveSettings: { settings in
                savedSettings.append(settings)
            },
            onPrepared: {
                preparedCallbacks += 1
            }
        )

        XCTAssertEqual(prepared, true)
        XCTAssertEqual(preparedCallbacks, 1)
        XCTAssertEqual(
            savedSettings,
            [
                AppSettings(
                    endpoint: "https://api.example:9443"
                )
            ]
        )

        let retry = await preparation.run(
            importResult: .imported,
            providerReady: true,
            pairingOrigin: "https://api.example:9443",
            saveSettings: { settings in
                savedSettings.append(settings)
            },
            onPrepared: {
                preparedCallbacks += 1
            }
        )

        XCTAssertNil(retry)
        XCTAssertEqual(savedSettings.count, 1)
        XCTAssertEqual(preparedCallbacks, 1)

        let runner = PAIOSDebugProductionStartOnce()
        var starts = 0
        let first = await runner.run(
            importResult: .imported,
            providerReady: true
        ) {
            starts += 1
            return true
        }
        let second = await runner.run(
            importResult: .imported,
            providerReady: true
        ) {
            starts += 1
            return true
        }

        XCTAssertEqual(first, .active)
        XCTAssertNil(second)
        XCTAssertEqual(starts, 1)
    }

    @MainActor
    func testDebugPhysicalEndpointPreparationWritesExactOriginWhenBundleAbsent()
        async {
        let preparation = PAIOSDebugPhysicalEndpointPreparationOnce()
        var savedSettings: [AppSettings] = []
        var preparedCallbacks = 0
        let prepared = await preparation.run(
            importResult: .absent,
            providerReady: true,
            pairingOrigin: "https://api.example:9443",
            saveSettings: { settings in
                savedSettings.append(settings)
            },
            onPrepared: {
                preparedCallbacks += 1
            }
        )

        let retry = await preparation.run(
            importResult: .absent,
            providerReady: true,
            pairingOrigin: "https://api.example:9443",
            saveSettings: { settings in
                savedSettings.append(settings)
            },
            onPrepared: {
                preparedCallbacks += 1
            }
        )

        XCTAssertEqual(prepared, true)
        XCTAssertNil(retry)
        XCTAssertEqual(preparedCallbacks, 1)
        XCTAssertEqual(
            savedSettings,
            [
                AppSettings(
                    endpoint: "https://api.example:9443"
                )
            ]
        )
    }

    @MainActor
    func testDebugPhysicalEndpointPreparationSaveFailureDoesNotStartOrRetry()
        async {
        let preparation = PAIOSDebugPhysicalEndpointPreparationOnce()
        var saveCalls = 0
        var preparedCallbacks = 0
        var starts = 0
        let prepared = await preparation.run(
            importResult: .imported,
            providerReady: true,
            pairingOrigin: "https://api.example:9443",
            saveSettings: { _ in
                saveCalls += 1
                throw NSError(domain: "test", code: 1)
            },
            onPrepared: {
                preparedCallbacks += 1
            }
        )
        let retry = await preparation.run(
            importResult: .imported,
            providerReady: true,
            pairingOrigin: "https://api.example:9443",
            saveSettings: { _ in
                saveCalls += 1
            },
            onPrepared: {
                preparedCallbacks += 1
            }
        )
        let marker: PAIOSDebugProductionStartMarker
        if prepared == true {
            let runner = PAIOSDebugProductionStartOnce()
            marker = await runner.run(
                importResult: .imported,
                providerReady: true
            ) {
                starts += 1
                return true
            } ?? .failed
        } else {
            marker = .notReady
        }

        XCTAssertEqual(prepared, false)
        XCTAssertNil(retry)
        XCTAssertEqual(saveCalls, 1)
        XCTAssertEqual(preparedCallbacks, 0)
        XCTAssertEqual(marker, .notReady)
        XCTAssertEqual(starts, 0)
    }

    @MainActor
    func testDebugPhysicalEndpointPreparationUnavailableInputsDoNotSaveOrStart()
        async {
        let cases: [(RealtimePairingImportResult, Bool)] = [
            (.rejected, true),
            (.absent, false),
            (.imported, false)
        ]

        for (result, providerReady) in cases {
            let preparation = PAIOSDebugPhysicalEndpointPreparationOnce()
            var saveCalls = 0
            var preparedCallbacks = 0
            let prepared = await preparation.run(
                importResult: result,
                providerReady: providerReady,
                pairingOrigin: "https://api.example:9443",
                saveSettings: { _ in
                    saveCalls += 1
                },
                onPrepared: {
                    preparedCallbacks += 1
                }
            )

            XCTAssertEqual(prepared, false)
            XCTAssertEqual(saveCalls, 0)
            XCTAssertEqual(preparedCallbacks, 0)
        }
    }

    @MainActor
    func testDebugPhysicalBundleLaunchAbsentOrRejectedNeverStarts() async {
        let supportURL = URL(fileURLWithPath: "/tmp/paios-launch-bridge")
        let cases: [(Bool, RealtimePairingImportResult)] = [
            (false, .absent),
            (true, .rejected)
        ]

        for (present, result) in cases {
            let autoImportRequested =
                PAIOSDebugPairingLaunch
                    .shouldAutoImportPairing(
                        arguments: ["PersonalAIOSPhase0"],
                        isPhysicalDevice: true,
                        applicationSupportURL: supportURL,
                        fileExists: { _ in present }
                    )
            let runner = PAIOSDebugProductionStartOnce()
            var calls = 0
            let marker: PAIOSDebugProductionStartMarker?
            if autoImportRequested {
                marker = await runner.run(
                    importResult: result,
                    providerReady: true
                ) {
                    calls += 1
                    return true
                }
            } else {
                marker = nil
            }

            XCTAssertEqual(autoImportRequested, present)
            if present {
                XCTAssertEqual(marker, .notReady)
            } else {
                XCTAssertNil(marker)
            }
            XCTAssertEqual(calls, 0)
        }
    }

    func testDebugPhysicalBundleLaunchLeavesExplicitArgumentsUnchanged() {
        let supportURL = URL(fileURLWithPath: "/tmp/paios-launch-bridge")
        var nonPhysicalFileChecks = 0
        XCTAssertFalse(
            PAIOSDebugPairingLaunch.shouldAutoImportPairing(
                arguments: ["PersonalAIOSPhase0"],
                isPhysicalDevice: false,
                applicationSupportURL: supportURL,
                fileExists: { _ in
                    nonPhysicalFileChecks += 1
                    return true
                }
            )
        )
        XCTAssertEqual(nonPhysicalFileChecks, 0)

        let argumentSets = [
            [
                "PersonalAIOSPhase0",
                PAIOSDebugPairingLaunch.devicePairingImport
            ],
            [
                "PersonalAIOSPhase0",
                PAIOSDebugPairingLaunch.devicePairingImport,
                PAIOSDebugPairingLaunch.productionStartOnce
            ],
            [
                "PersonalAIOSPhase0",
                PAIOSDebugPairingLaunch.registrationExport
            ]
        ]

        for arguments in argumentSets {
            XCTAssertFalse(
                PAIOSDebugPairingLaunch
                    .shouldAutoImportPairing(
                        arguments: arguments,
                        isPhysicalDevice: true,
                        applicationSupportURL: supportURL,
                        fileExists: { _ in true }
                    )
            )
        }
        XCTAssertEqual(
            PAIOSDebugPairingLaunch.devicePairingImport,
            "--paios-device-pairing-import"
        )
        XCTAssertEqual(
            PAIOSDebugPairingLaunch.productionStartOnce,
            "--paios-production-start-once"
        )
    }

    @MainActor
    func testDebugProductionStartOnceRunsImportedProviderReadyOnce() async {
        let runner = PAIOSDebugProductionStartOnce()
        var calls = 0

        let marker = await runner.run(
            importResult: .imported,
            providerReady: true
        ) {
            calls += 1
            return true
        }

        XCTAssertEqual(
            PAIOSDebugProductionStartOnce.launchArgument,
            "--paios-production-start-once"
        )
        XCTAssertEqual(marker, .active)
        XCTAssertEqual(calls, 1)
    }

    func testDebugProductionStartErrorMarkerAllowsKnownCodesOnly() {
        let knownCodes = [
            "bootstrap_not_configured",
            "camera_denied",
            "disconnected",
            "e2ee_failed",
            "e2ee_unavailable",
            "location_denied",
            "microphone_denied",
            "network",
            "realtime_superseded",
            "start_failed"
        ]
        for code in knownCodes {
            XCTAssertEqual(
                PAIOSDebugProductionStartErrorMarker.value(
                    for: .failed(code: code)
                ),
                code
            )
        }
        XCTAssertEqual(
            PAIOSDebugProductionStartErrorMarker.value(
                for: .failed(
                    code: "https://forbidden.invalid/token/secret"
                )
            ),
            "UNKNOWN"
        )
        XCTAssertEqual(
            PAIOSDebugProductionStartErrorMarker.value(for: .idle),
            "UNKNOWN"
        )
    }

    @MainActor
    func testDebugProductionStartOnceRejectsUnavailableInputs() async {
        let cases: [(RealtimePairingImportResult, Bool)] = [
            (.rejected, true),
            (.absent, false),
            (.imported, false)
        ]

        for (result, providerReady) in cases {
            let runner = PAIOSDebugProductionStartOnce()
            var calls = 0
            let marker = await runner.run(
                importResult: result,
                providerReady: providerReady
            ) {
                calls += 1
                return true
            }
            XCTAssertEqual(marker, .notReady)
            XCTAssertEqual(calls, 0)
        }
    }

    @MainActor
    func testDebugProductionStartOnceRunsPersistedAbsentProviderReadyOnce()
        async {
        let runner = PAIOSDebugProductionStartOnce()
        var calls = 0
        let first = await runner.run(
            importResult: .absent,
            providerReady: true
        ) {
            calls += 1
            return true
        }
        let second = await runner.run(
            importResult: .absent,
            providerReady: true
        ) {
            calls += 1
            return true
        }

        XCTAssertEqual(first, .active)
        XCTAssertNil(second)
        XCTAssertEqual(calls, 1)
    }

    @MainActor
    func testDebugProductionStartOnceIsProcessLocalIdempotent() async {
        let runner = PAIOSDebugProductionStartOnce()
        var calls = 0
        let first = await runner.run(
            importResult: .imported,
            providerReady: true
        ) {
            calls += 1
            return true
        }
        let second = await runner.run(
            importResult: .imported,
            providerReady: true
        ) {
            calls += 1
            return true
        }

        XCTAssertEqual(first, .active)
        XCTAssertNil(second)
        XCTAssertEqual(calls, 1)
    }
#endif

#if DEBUG && os(iOS)
    func testPhysicalPreworkoutExporterUsesHiddenOneShotArgument() {
        XCTAssertEqual(
            PhysicalCanaryPreworkoutObservationExporter.launchArgument,
            "--paios-physical-canary-preworkout-export"
        )
        XCTAssertEqual(
            PhysicalCanaryPreworkoutObservationExporter.requestSchema,
            "paios.apple-physical-preworkout-request.v1"
        )
        XCTAssertEqual(
            PhysicalCanaryPreworkoutObservationExporter.observationSchema,
            "paios.apple-physical-preworkout-observation.v1"
        )
        XCTAssertEqual(
            PhysicalCanaryPreworkoutObservationExporter.statusSchema,
            "paios.apple-physical-preworkout-status.v1"
        )
    }
#endif

    func testLocalCompositionSeamsAreClientLocal() async throws {
        let provider = AssistantLoopbackProvider()
#if DEBUG
        let details = try await provider.bootstrap(
            for: AssistantStartIntent(userInitiated: true)
        )
        XCTAssertEqual(details.roomName, "debug-loopback-room")
        XCTAssertTrue(details.capabilities.canPublishData)
#else
        do {
            _ = try await provider.bootstrap(
                for: AssistantStartIntent(userInitiated: true)
            )
            XCTFail("Release must fail closed")
        } catch {
            XCTAssertEqual(error as? AssistantBootstrapError, .notConfigured)
        }
#endif
    }

    func testLoopbackUsesAUniqueResultStreamPerSession() async throws {
#if DEBUG
        let provider = AssistantLoopbackProvider()
        let details = try await provider.bootstrap(
            for: AssistantStartIntent(userInitiated: true)
        )
        let transport = AssistantLoopbackRealtimeTransport()
        let probe = LoopbackEventProbe()
        let request = AssistantRealtimeConnectRequest(
            details: details,
            intent: AssistantStartIntent(userInitiated: true)
        )

        try await transport.connect(request) { event in
            Task {
                await probe.record(event)
            }
        }
        await transport.stop()
        try await transport.connect(request) { event in
            Task {
                await probe.record(event)
            }
        }
        // Each local session emits one partial and one final frame. Wait for
        // all four frames, then assert that only two stream identities exist.
        await probe.waitFor(count: 4)

        let streamIDs = await probe.streamIDs
        let epochs = await probe.epochs
        XCTAssertEqual(streamIDs.count, 4)
        XCTAssertEqual(Set(streamIDs).count, 2)
        // Raw loopback frames model the real wire and carry no local epoch.
        XCTAssertEqual(epochs, [0, 0, 0, 0])
#else
        XCTAssertTrue(true)
#endif
    }

#if DEBUG
    func testPhysicalCanaryConfigurationRequiresClosedInputSet()
        throws {
        let environment = try makePhysicalCanaryEnvironment()
        let configuration = try PhysicalCanaryConfiguration.parse(
            environment: environment
        ).get()

        XCTAssertEqual(
            configuration.serverURL.absoluteString,
            "wss://canary.example.invalid"
        )
        XCTAssertEqual(configuration.roomName, "cycling_session_01")
        XCTAssertEqual(configuration.e2eeKeyData.count, 32)
        XCTAssertEqual(configuration.watchBinding.deviceID, "watch_01")
        XCTAssertEqual(
            configuration.watchBinding.clientInstanceID,
            "watch_client_01"
        )
    }

    func testPhysicalCanaryMissingInputFailsClosedByCount() throws {
        var environment = try makePhysicalCanaryEnvironment()
        environment.removeValue(
            forKey: PhysicalCanaryInputKey.participantToken
        )

        let result = PhysicalCanaryConfiguration.parse(
            environment: environment
        )

        XCTAssertEqual(
            result.failure,
            .missingInputCount(1)
        )
    }

    func testProtectedPhysicalCanaryInputConsumesExactSixAndDeletesFile()
        throws {
        try withTemporaryPhysicalCanaryInput { fileURL, fileManager in
            try writePhysicalCanaryInput(
                makePhysicalCanaryEnvironment(),
                to: fileURL
            )

            let configuration = try PhysicalCanaryProtectedInputFile.consume(
                at: fileURL,
                fileManager: fileManager,
                applyAndVerifyPolicy: applySimulatorFilePolicy
            ).get()

            XCTAssertEqual(
                configuration.serverURL.absoluteString,
                "wss://canary.example.invalid"
            )
            XCTAssertEqual(configuration.roomName, "cycling_session_01")
            XCTAssertEqual(configuration.e2eeKeyData.count, 32)
            XCTAssertEqual(configuration.watchBinding.deviceID, "watch_01")
            XCTAssertFalse(fileManager.fileExists(atPath: fileURL.path))

            XCTAssertEqual(
                PhysicalCanaryProtectedInputFile.consume(
                    at: fileURL,
                    fileManager: fileManager
                ).failure,
                .missingInputCount(PhysicalCanaryInputKey.all.count)
            )
        }
    }

    func testProtectedPhysicalCanaryInputIgnoresPopulatedEnvironmentWhenMissing()
        throws {
        let environment = try makePhysicalCanaryEnvironment()
        let previousValues = PhysicalCanaryInputKey.all.reduce(
            into: [String: String?]()
        ) { values, key in
            values[key] = ProcessInfo.processInfo.environment[key]
        }
        for (key, value) in environment {
            setenv(key, value, 1)
        }
        defer {
            for key in PhysicalCanaryInputKey.all {
                if let value = previousValues[key] ?? nil {
                    setenv(key, value, 1)
                } else {
                    unsetenv(key)
                }
            }
        }

        try withTemporaryPhysicalCanaryInput { fileURL, fileManager in
            XCTAssertEqual(
                PhysicalCanaryProtectedInputFile.consume(
                    at: fileURL,
                    fileManager: fileManager
                ).failure,
                .missingInputCount(PhysicalCanaryInputKey.all.count)
            )
            XCTAssertFalse(fileManager.fileExists(atPath: fileURL.path))
        }
    }

    func testProtectedPhysicalCanaryInputRejectsInvalidEnvelopesAndDeletesFile()
        throws {
        var missing = try makePhysicalCanaryEnvironment()
        missing.removeValue(forKey: PhysicalCanaryInputKey.participantToken)
        var extra = try makePhysicalCanaryEnvironment()
        extra["UNEXPECTED"] = "value"
        var nonString = try makePhysicalCanaryEnvironment()
            .reduce(into: [String: Any]()) { values, entry in
                values[entry.key] = entry.value
            }
        nonString[PhysicalCanaryInputKey.watchDeviceClass] = 1

        let cases: [(String, Data, PhysicalCanaryInputError)] = [
            (
                "missing",
                try JSONSerialization.data(withJSONObject: missing),
                .invalidInputCount(1)
            ),
            (
                "extra",
                try JSONSerialization.data(withJSONObject: extra),
                .invalidInputCount(1)
            ),
            (
                "non-string",
                try JSONSerialization.data(withJSONObject: nonString),
                .invalidInputCount(1)
            ),
            ("malformed", Data("{".utf8), .invalidInputCount(1)),
            (
                "oversize",
                Data(
                    repeating: 0x78,
                    count: PhysicalCanaryProtectedInputFile.maximumByteCount + 1
                ),
                .invalidInputCount(1)
            )
        ]

        for (name, data, expectedError) in cases {
            try withTemporaryPhysicalCanaryInput { fileURL, fileManager in
                try data.write(to: fileURL)
                XCTAssertEqual(
                    PhysicalCanaryProtectedInputFile.consume(
                        at: fileURL,
                        fileManager: fileManager
                    ).failure,
                    expectedError,
                    name
                )
                XCTAssertFalse(
                    fileManager.fileExists(atPath: fileURL.path),
                    name
                )
            }
        }
    }

    func testProtectedPhysicalCanaryInputRejectsSymlinkAndPolicyFailure()
        throws {
        try withTemporaryPhysicalCanaryInput { fileURL, fileManager in
            let targetURL = fileURL.deletingLastPathComponent()
                .appendingPathComponent("target.json")
            try writePhysicalCanaryInput(
                makePhysicalCanaryEnvironment(),
                to: targetURL
            )
            try fileManager.createSymbolicLink(
                at: fileURL,
                withDestinationURL: targetURL
            )

            XCTAssertEqual(
                PhysicalCanaryProtectedInputFile.consume(
                    at: fileURL,
                    fileManager: fileManager
                ).failure,
                .invalidInputCount(1)
            )
            XCTAssertFalse(fileManager.fileExists(atPath: fileURL.path))
            XCTAssertTrue(fileManager.fileExists(atPath: targetURL.path))
        }

        try withTemporaryPhysicalCanaryInput { fileURL, fileManager in
            try writePhysicalCanaryInput(
                makePhysicalCanaryEnvironment(),
                to: fileURL
            )
            let result = PhysicalCanaryProtectedInputFile.consume(
                at: fileURL,
                fileManager: fileManager
            ) { _, _ in
                throw CocoaError(.fileWriteNoPermission)
            }

            XCTAssertEqual(result.failure, .invalidInputCount(1))
            XCTAssertFalse(fileManager.fileExists(atPath: fileURL.path))
        }
    }

    func testPhysicalCanaryInputsAreConsumedOnceWithoutNetwork()
        async throws {
        let configuration = try PhysicalCanaryConfiguration.parse(
            environment: makePhysicalCanaryEnvironment()
        ).get()
        let diagnostics = PhysicalCanaryDiagnostics()
        let bootstrap = PhysicalCanaryBootstrapProvider(
            configuration: configuration,
            diagnostics: diagnostics
        )
        let encryption = PhysicalCanaryEncryptionProvider(
            keyData: configuration.e2eeKeyData,
            diagnostics: diagnostics
        )

        XCTAssertEqual(
            diagnostics.snapshot(),
            PhysicalCanaryDiagnosticCounts()
        )
        let details = try await bootstrap.bootstrap(
            for: AssistantStartIntent(userInitiated: true)
        )
        XCTAssertEqual(details.roomName, "cycling_session_01")
        XCTAssertTrue(details.capabilities.canPublishData)
        XCTAssertTrue(details.capabilities.publishableSources.isEmpty)
        _ = try await encryption.makeEncryptionOptions()

        do {
            _ = try await bootstrap.bootstrap(
                for: AssistantStartIntent(userInitiated: true)
            )
            XCTFail("Expected one-time bootstrap rejection")
        } catch {
            XCTAssertEqual(
                error as? AssistantBootstrapError,
                .notConfigured
            )
        }
        do {
            _ = try await encryption.makeEncryptionOptions()
            XCTFail("Expected one-time E2EE rejection")
        } catch {
            XCTAssertEqual(
                error as? LiveKitSessionError,
                .e2eeUnavailable
            )
        }

        let counts = diagnostics.snapshot()
        XCTAssertEqual(counts.bootstrapConsumed, 1)
        XCTAssertEqual(counts.e2eeConsumed, 1)
        XCTAssertEqual(counts.duplicateConsumeRejected, 2)
    }

    private func makePhysicalCanaryEnvironment()
        throws -> [String: String] {
        let header = try JSONSerialization.data(withJSONObject: [
            "alg": "HS256",
            "typ": "JWT"
        ])
        let payload = try JSONSerialization.data(withJSONObject: [
            "sub": "iphone_01",
            "attributes": [
                "schema_version": "phase0-demo/0.4",
                "device_id": "iphone_01",
                "device_class": "iphone",
                "client_instance_id": "iphone_client_01"
            ],
            "video": [
                "room": "cycling_session_01",
                "roomJoin": true,
                "canPublishData": true
            ]
        ])
        let token = [
            base64URL(header),
            base64URL(payload),
            base64URL(Data("signed".utf8))
        ].joined(separator: ".")

        return [
            PhysicalCanaryInputKey.serverURL:
                "wss://canary.example.invalid",
            PhysicalCanaryInputKey.participantToken: token,
            PhysicalCanaryInputKey.e2eeKeyBase64:
                Data((0..<32).map(UInt8.init)).base64EncodedString(),
            PhysicalCanaryInputKey.watchDeviceID: "watch_01",
            PhysicalCanaryInputKey.watchClientInstanceID:
                "watch_client_01",
            PhysicalCanaryInputKey.watchDeviceClass: "apple_watch"
        ]
    }

    private func withTemporaryPhysicalCanaryInput(
        _ body: (URL, FileManager) throws -> Void
    ) throws {
        let fileManager = FileManager.default
        let libraryURL = try XCTUnwrap(
            fileManager.urls(for: .libraryDirectory, in: .userDomainMask)
                .first
        )
        let rootURL = libraryURL
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent(
                "PersonalAIOS/PhysicalCanaryTests/\(UUID().uuidString)",
                isDirectory: true
            )
        try fileManager.createDirectory(
            at: rootURL,
            withIntermediateDirectories: true
        )
        defer {
            try? fileManager.removeItem(at: rootURL)
        }
        try body(
            rootURL.appendingPathComponent(
                "physical-canary-inputs.v1.json"
            ),
            fileManager
        )
    }

    private func writePhysicalCanaryInput(
        _ values: [String: String],
        to fileURL: URL
    ) throws {
        try JSONSerialization.data(withJSONObject: values).write(to: fileURL)
    }

    private func applySimulatorFilePolicy(
        _ fileURL: URL,
        _ fileManager: FileManager
    ) throws {
        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: 0o600)],
            ofItemAtPath: fileURL.path
        )
        var mutableURL = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try mutableURL.setResourceValues(values)

        let attributes = try fileManager.attributesOfItem(
            atPath: fileURL.path
        )
        let permissions = attributes[.posixPermissions] as? NSNumber
        let verifiedValues = try fileURL.resourceValues(
            forKeys: [.isExcludedFromBackupKey]
        )
        guard permissions?.intValue == 0o600,
              verifiedValues.isExcludedFromBackup == true
        else {
            throw CocoaError(.fileWriteNoPermission)
        }
    }

    private func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
#endif

    @MainActor
    func testVideoPreviewClearsTypedUpdate() {
        let model = AssistantVideoPreviewModel()
        model.update(
            AssistantVideoTrackUpdate(
                localVideoTrack: nil,
                remoteVideoTrack: nil
            )
        )
        XCTAssertNil(model.localVideoTrack)
        XCTAssertNil(model.remoteVideoTrack)
        model.update(.cleared)
        XCTAssertNil(model.localVideoTrack)
        XCTAssertNil(model.remoteVideoTrack)
    }
}

#if DEBUG
private extension Result {
    var failure: Failure? {
        guard case .failure(let error) = self else {
            return nil
        }
        return error
    }
}
#endif

#if DEBUG
private actor LoopbackEventProbe {
    private(set) var streamIDs: [String] = []
    private(set) var epochs: [UInt64] = []

    func record(_ event: AssistantRealtimeEvent) {
        guard case .result(let envelope) = event else {
            return
        }
        streamIDs.append(envelope.streamID)
        epochs.append(envelope.epoch)
    }

    func waitFor(count: Int) async {
        while streamIDs.count < count {
            await Task.yield()
        }
    }
}
#endif
