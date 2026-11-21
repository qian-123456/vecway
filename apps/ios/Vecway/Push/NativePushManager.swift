import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif

/// Native push notification status matching the TypeScript `NativePushStatus` bridge contract.
public struct NativePushStatus: Codable, Equatable, Sendable {
    public let supported: Bool
    public let permission: String
    public let registered: Bool
    public let reason: String?

    public init(
        supported: Bool,
        permission: String,
        registered: Bool,
        reason: String? = nil
    ) {
        self.supported = supported
        self.permission = permission
        self.registered = registered
        self.reason = reason
    }
}

/// Extension slot for paid Apple Developer APNs push notifications (M5-ready).
/// Preserves full `UNUserNotificationCenter` & APNs device token plumbing while truthfully
/// reporting `supported: false` until the desktop `/api/push/register-native` endpoint lands.
@MainActor
final class NativePushManager: ObservableObject {
    static let pendingServerReason = "桌面端原生推送服务将在下一阶段启用，当前已保留 APNs 接入能力"

    @Published private(set) var apnsDeviceTokenHex: String?
    @Published private(set) var lastRegistrationError: String?

    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        apnsDeviceTokenHex = hex
        lastRegistrationError = nil
    }

    func didFailToRegisterForRemoteNotifications(error: Error) {
        lastRegistrationError = error.localizedDescription
    }

    func getStatus() async -> NativePushStatus {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let permission = Self.mapAuthorizationStatus(settings.authorizationStatus)
        return NativePushStatus(
            supported: false,
            permission: permission,
            registered: false,
            reason: Self.pendingServerReason
        )
    }

    func enable() async throws {
        let center = UNUserNotificationCenter.current()
        let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
        guard granted else {
            throw NSError(
                domain: "dev.vecway.mobile.push",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "未获得系统通知权限，请在「设置 → Vecway → 通知」中开启"]
            )
        }
        #if canImport(UIKit)
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }

    func disable() async {
        #if canImport(UIKit)
        UIApplication.shared.unregisterForRemoteNotifications()
        #endif
        apnsDeviceTokenHex = nil
    }

    private static func mapAuthorizationStatus(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral:
            return "granted"
        case .denied:
            return "denied"
        case .notDetermined:
            return "default"
        @unknown default:
            return "default"
        }
    }
}
