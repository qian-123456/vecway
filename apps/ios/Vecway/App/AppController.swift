import Foundation
import SwiftUI
import UIKit

/// Main-actor coordinator owning all native services (`EndpointManager`, `SSEBridge`, `BridgeRouter`,
/// `AppSchemeHandler`, `NativeVoiceRecorder`, `NativePushManager`) and SwiftUI presentation state.
@MainActor
final class AppController: ObservableObject {
    enum PairScannerMode: String, Sendable {
        case scan
        case domain
    }

    let credentialStore: KeychainStore
    let transport: PinnedTransport
    let endpointManager: EndpointManager
    let sseBridge: SSEBridge
    let voiceRecorder: NativeVoiceRecorder
    let pushManager: NativePushManager
    let schemeHandler: AppSchemeHandler
    private(set) var bridgeRouter: BridgeRouter!

    @Published private(set) var status: NativeEndpointStatus
    @Published var isScannerPresented: Bool = false
    @Published var scannerInitialMode: PairScannerMode = .scan
    @Published var pendingDeepLinkPayload: PairingPayload?
    @Published var deepLinkError: String?
    @Published var preferredColorScheme: ColorScheme? = nil
    @Published var appearanceBackgroundColor: UIColor = .systemBackground

    var preferredUIUserInterfaceStyle: UIUserInterfaceStyle {
        switch preferredColorScheme {
        case .light:
            return .light
        case .dark:
            return .dark
        case nil:
            return .unspecified
        @unknown default:
            return .unspecified
        }
    }

    private var scannerContinuation: CheckedContinuation<ScannerOutcome, Never>?
    private var scannerCompletedOutcome: ScannerOutcome?
    private var statusListenerId: UUID?
    private var wasInBackground = false

    init() {
        let store = KeychainStore()
        let transport = PinnedTransport()
        let endpointManager = EndpointManager(store: store, transport: transport)
        let sseBridge = SSEBridge()
        let voiceRecorder = NativeVoiceRecorder(endpointManager: endpointManager)
        let pushManager = NativePushManager()
        let schemeHandler = AppSchemeHandler(endpointManager: endpointManager)

        self.credentialStore = store
        self.transport = transport
        self.endpointManager = endpointManager
        self.sseBridge = sseBridge
        self.voiceRecorder = voiceRecorder
        self.pushManager = pushManager
        self.schemeHandler = schemeHandler
        self.status = endpointManager.currentStatus()

        self.bridgeRouter = BridgeRouter(
            endpointManager: endpointManager,
            sseBridge: sseBridge,
            voiceRecorder: voiceRecorder,
            pushManager: pushManager,
            openScannerHandler: { [weak self] mode in
                guard let self else {
                    return ScannerOutcome(ok: false, error: "应用已释放", status: nil)
                }
                return await self.openScannerFromBridge(mode: mode)
            },
            setAppearanceHandler: { [weak self] mode, backgroundHex in
                self?.updateAppearance(mode: mode, backgroundHex: backgroundHex)
            }
        )

        endpointManager.onWillUnpair = { [weak sseBridge] in
            sseBridge?.closeAll()
        }
        endpointManager.onPinMismatchDetected = { [weak sseBridge] _ in
            sseBridge?.closeAll()
        }
        endpointManager.onUnauthorized = { [weak sseBridge] in
            sseBridge?.closeAll()
        }
        endpointManager.onActiveChannelChanged = { [weak self, weak sseBridge] _, _ in
            sseBridge?.closeAll(notifyDisconnected: true)
            Task { @MainActor [weak self] in
                guard let self, self.status.pinMismatch == nil else { return }
                self.bridgeRouter.notifyForegroundResync()
            }
        }

        statusListenerId = endpointManager.addStatusListener { [weak self] newStatus in
            Task { @MainActor [weak self] in
                self?.applyStatusUpdate(newStatus)
            }
        }

        endpointManager.startNetworkMonitoring()

        if status.paired && status.pinMismatch == nil {
            Task { [weak self] in
                guard let self else { return }
                _ = await self.endpointManager.reprobeConnection()
            }
        }
    }

    deinit {
        if let id = statusListenerId {
            endpointManager.removeStatusListener(id)
        }
        endpointManager.stopNetworkMonitoring()
        sseBridge.closeAll()
    }

    // MARK: - Pairing & Scanner

    func openScannerFromBridge(mode: PairScannerMode = .scan) async -> ScannerOutcome {
        if let existing = scannerContinuation {
            scannerContinuation = nil
            existing.resume(returning: ScannerOutcome(ok: false, error: "已被新的扫码请求取代", status: nil))
        }

        scannerCompletedOutcome = nil
        pendingDeepLinkPayload = nil
        scannerInitialMode = mode
        isScannerPresented = true

        return await withCheckedContinuation { continuation in
            self.scannerContinuation = continuation
        }
    }

    func openScannerManually(mode: PairScannerMode = .scan) {
        scannerCompletedOutcome = nil
        pendingDeepLinkPayload = nil
        scannerInitialMode = mode
        isScannerPresented = true
    }

    func confirmPairing(payload: PairingPayload) async throws {
        let deviceName = UIDevice.current.name
        let newStatus = try await endpointManager.pair(payload: payload, deviceName: deviceName)
        scannerCompletedOutcome = ScannerOutcome(ok: true, error: nil, status: newStatus)
    }

    func handleScannerDismissed() {
        pendingDeepLinkPayload = nil
        let outcome = scannerCompletedOutcome ?? ScannerOutcome(ok: false, error: "已取消扫码", status: nil)
        scannerCompletedOutcome = nil

        if let continuation = scannerContinuation {
            scannerContinuation = nil
            continuation.resume(returning: outcome)
        }
    }

    func unpair() {
        Task { [weak self] in
            guard let self else { return }
            try? await self.endpointManager.unpair()
        }
    }

    // MARK: - Deep Links & Scene Lifecycle

    func handleIncomingURL(_ url: URL) {
        guard url.scheme?.lowercased() == AppSchemeHandler.scheme,
              url.host?.lowercased() == "pair" else {
            return
        }
        do {
            let payload = try PairingPayload.parse(url.absoluteString)
            scannerCompletedOutcome = nil
            scannerInitialMode = .scan
            pendingDeepLinkPayload = payload
            isScannerPresented = true
        } catch {
            deepLinkError = error.localizedDescription
        }
    }

    func handleScenePhaseChange(_ phase: ScenePhase) {
        switch phase {
        case .background:
            wasInBackground = true
        case .active:
            if wasInBackground {
                wasInBackground = false
                guard status.paired && status.pinMismatch == nil else { return }
                Task { [weak self] in
                    guard let self else { return }
                    _ = await self.endpointManager.reprobeConnection()
                    if self.status.pinMismatch == nil {
                        self.bridgeRouter.notifyForegroundResync()
                    }
                }
            }
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    // MARK: - Appearance

    func updateAppearance(mode: String, backgroundHex: String?) {
        switch mode {
        case "light":
            preferredColorScheme = .light
        case "dark":
            preferredColorScheme = .dark
        default:
            preferredColorScheme = nil
        }
        appearanceBackgroundColor = Self.parseColor(hex: backgroundHex) ?? .systemBackground
    }

    private static func parseColor(hex: String?) -> UIColor? {
        guard let raw = hex?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        let cleaned = raw.hasPrefix("#") ? String(raw.dropFirst()) : raw
        let expanded: String
        if cleaned.count == 3 {
            expanded = cleaned.map { "\($0)\($0)" }.joined()
        } else {
            expanded = cleaned
        }
        guard expanded.count == 6 || expanded.count == 8,
              let value = UInt64(expanded, radix: 16) else {
            return nil
        }
        if expanded.count == 6 {
            let r = CGFloat((value >> 16) & 0xFF) / 255.0
            let g = CGFloat((value >> 8) & 0xFF) / 255.0
            let b = CGFloat(value & 0xFF) / 255.0
            return UIColor(red: r, green: g, blue: b, alpha: 1.0)
        }
        let r = CGFloat((value >> 24) & 0xFF) / 255.0
        let g = CGFloat((value >> 16) & 0xFF) / 255.0
        let b = CGFloat((value >> 8) & 0xFF) / 255.0
        let a = CGFloat(value & 0xFF) / 255.0
        return UIColor(red: r, green: g, blue: b, alpha: a)
    }

    // MARK: - Private

    private func applyStatusUpdate(_ newStatus: NativeEndpointStatus) {
        status = newStatus
        if newStatus.pinMismatch != nil {
            sseBridge.closeAll()
        }
        bridgeRouter.notifyConnectionStatus(newStatus)
    }
}
