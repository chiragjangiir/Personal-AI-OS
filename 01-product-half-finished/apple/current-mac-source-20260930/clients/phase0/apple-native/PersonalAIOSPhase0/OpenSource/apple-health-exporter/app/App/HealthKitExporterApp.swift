import Foundation
import SwiftUI
import UIKit


@main
struct HealthKitExporterApp: App {
    @State private var model: AppModel?
    @State private var composition: AssistantComposition?
#if DEBUG
    @State private var pairingStatus: String?
    @State private var productionStartOnceRequested = false
    @State private var productionRecoveryAttempted = false
    private let debugPhysicalEndpointPreparationInput:
        (importResult: RealtimePairingImportResult, pairingOrigin: String)?
    private static let productionStartOnce =
        PAIOSDebugProductionStartOnce()
    private static let productionEndpointPreparation =
        PAIOSDebugPhysicalEndpointPreparationOnce()
#endif
    @Environment(\.scenePhase) private var scenePhase

    init() {
#if DEBUG
        let arguments = PAIOSDebugPairingLaunch.arguments
        let autoImportRequested: Bool
#if os(iOS) && !targetEnvironment(simulator)
        autoImportRequested =
            PAIOSDebugPairingLaunch.shouldAutoImportPairing(
                arguments: arguments,
                isPhysicalDevice: true,
                applicationSupportURL:
                    RealtimeDevicePairingRuntime.applicationSupportURL(),
                fileExists: {
                    FileManager.default.fileExists(atPath: $0.path)
                }
            )
#else
        autoImportRequested = false
#endif
        if arguments.contains(PAIOSDebugPairingLaunch.registrationExport) {
            let status: String
            if let support = RealtimeDevicePairingRuntime
                .applicationSupportURL() {
                let destination = support
                    .appendingPathComponent(
                        RealtimeDevicePairingRuntime
                            .registrationRelativePath
                    )
                do {
                    try RealtimeE2EERegistrationRuntime.exportRegistration(
                        to: destination
                    )
                    status = PAIOSDebugPairingPresentation.exportSucceeded
                } catch {
                    status = PAIOSDebugPairingPresentation.exportFailed
                }
            } else {
                status = PAIOSDebugPairingPresentation
                    .supportDirectoryUnavailable
            }
            _model = State(initialValue: nil)
            _composition = State(initialValue: nil)
            _pairingStatus = State(initialValue: status)
            productionStartOnceRequested = false
            debugPhysicalEndpointPreparationInput = nil
        } else if arguments.contains(
            PAIOSDebugPairingLaunch.devicePairingImport
        ) || autoImportRequested {
            let startOnceRequested = arguments.contains(
                PAIOSDebugPairingLaunch.productionStartOnce
            ) || autoImportRequested
            let status: String
            let result: RealtimePairingImportResult?
            if let support = RealtimeDevicePairingRuntime
                .applicationSupportURL() {
                let source = support
                    .appendingPathComponent(
                        RealtimeDevicePairingRuntime.pairingRelativePath
                    )
                let importResult = RealtimeDevicePairingRuntime.importPairing(from: source)
                result = importResult
                status = importResult == .imported
                    ? PAIOSDebugPairingPresentation.importSucceeded
                    : PAIOSDebugPairingPresentation.importRejected
            } else {
                result = nil
                status = PAIOSDebugPairingPresentation.importUnavailable
            }

            let pairing = try? PairedRealtimeRequestBodyProvider().pairing()
            let keychainProviderReady = startOnceRequested && pairing != nil
            let productionStartEligible =
                PAIOSDebugPhysicalProductionLaunch.shouldPrepareEndpoint(
                    importResult: result,
                    providerReady: keychainProviderReady,
                    startOnceRequested: startOnceRequested
                )
            if productionStartEligible, let importResult = result, let pairing {
                _model = State(initialValue: nil)
                _composition = State(initialValue: nil)
                _pairingStatus = State(initialValue: nil)
                productionStartOnceRequested = false
                debugPhysicalEndpointPreparationInput = (
                    importResult: importResult,
                    pairingOrigin: pairing.origin
                )
            } else {
                _model = State(initialValue: nil)
                _composition = State(initialValue: nil)
                _pairingStatus = State(
                    initialValue: startOnceRequested
                        ? PAIOSDebugProductionStartMarker.notReady.rawValue
                        : status
                )
                productionStartOnceRequested = false
                debugPhysicalEndpointPreparationInput = nil
            }
        } else {
            let assistant = AssistantComposition()
            _model = State(initialValue: AppModel(placeFlush: { await assistant.flushPlaces() }))
            _composition = State(initialValue: assistant)
            _pairingStatus = State(initialValue: nil)
            productionStartOnceRequested = false
            debugPhysicalEndpointPreparationInput = nil
        }
#else
        let assistant = AssistantComposition()
        _model = State(initialValue: AppModel(placeFlush: { await assistant.flushPlaces() }))
        _composition = State(initialValue: assistant)
#endif
    }

#if DEBUG
    @MainActor
    private func prepareDebugPhysicalEndpointIfNeeded() async {
        guard let input = debugPhysicalEndpointPreparationInput else {
            return
        }
        let settingsStore = UserDefaultsSettingsStore()
        let prepared = await Self.productionEndpointPreparation.run(
            importResult: input.importResult,
            providerReady: true,
            pairingOrigin: input.pairingOrigin,
            saveSettings: { settings in
                try await settingsStore.saveSettings(settings)
            },
            onPrepared: {
                let assistant = AssistantComposition()
                composition = assistant
                model = AppModel(placeFlush: { await assistant.flushPlaces() })
                productionStartOnceRequested = true
            }
        )
        guard let prepared else {
            return
        }
        guard prepared else {
            pairingStatus = PAIOSDebugProductionStartMarker
                .notReady.rawValue
            return
        }
    }
#endif

    var body: some Scene {
        WindowGroup {
            if let model, let composition {
                YimiRootView(vm: composition.viewModel, placeSensing: composition.placeSensing)
                .environmentObject(model)
                .onOpenURL { url in Task { await composition.viewModel.receiveQwenCallback(url) } }
#if DEBUG
                .task {
                    guard productionStartOnceRequested else {
                        return
                    }
                    guard let startInput =
                        debugPhysicalEndpointPreparationInput
                    else {
                        return
                    }
                    let marker = await Self.productionStartOnce.run(
                        importResult: startInput.importResult,
                        providerReady: true
                    ) {
                        // Start only once the coordinator has published its first snapshot (canStart is false before).
                        for _ in 0..<50 where !composition.viewModel.canStart {
                            try? await Task.sleep(nanoseconds: 100_000_000)
                        }
                        await composition.viewModel.start()
                        if case .active =
                            composition.viewModel.sessionState {
                            return true
                        }
                        return false
                    }
                    guard let marker else {
                        return
                    }
                    print(
                        "PAIOS_PRODUCTION_START_ONCE_STATUS=" +
                            marker.rawValue
                    )
                    if marker == .failed {
                        print(
                            "PAIOS_PRODUCTION_START_ONCE_ERROR=" +
                                PAIOSDebugProductionStartErrorMarker.value(
                                    for: composition.viewModel.sessionState
                                )
                        )
                    }
                }
#endif
                .onReceive(
                    NotificationCenter.default.publisher(
                        for: UIApplication
                            .protectedDataDidBecomeAvailableNotification
                    )
                ) { _ in
                    model.protectedDataDidBecomeAvailable()
                }
            } else {
#if DEBUG
                if let pairingStatus {
                    VStack(spacing: 16) {
                        Text(PAIOSDebugPairingPresentation.title)
                            .font(.title2.weight(.semibold))
                        Text(pairingStatus)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 24)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(uiColor: .systemBackground))
                } else {
                    Color.clear
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .task {
                            await prepareDebugPhysicalEndpointIfNeeded()
                        }
                }
#else
                EmptyView()
#endif
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard let model, let composition else {
                return
            }
            if newPhase == .active {
#if canImport(WatchConnectivity)
                composition.activateWatchIfNeeded()
#endif
                model.appDidBecomeActive()
                composition.placeSensing?.appBecameActive()
                Task {
                    await composition.viewModel.appBecameActive()
#if DEBUG
                    if PAIOSDebugPhysicalProductionLaunch.shouldRetryAfterForeground(
                        startOnceRequested: productionStartOnceRequested,
                        recoveryAttempted: productionRecoveryAttempted,
                        sessionState: composition.viewModel.sessionState
                    ) {
                        productionRecoveryAttempted = true
                        await composition.viewModel.start()
                    }
#endif
                }
            } else if newPhase == .background {
                composition.placeSensing?.appDidEnterBackground()
                Task {
                    await composition.viewModel.appDidEnterBackground()
                }
            }
        }
    }
}
