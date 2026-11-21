import SwiftUI
import UIKit

/// `UIApplicationDelegate` adaptor forwarding APNs device token callbacks into `NativePushManager` (M5-ready).
@MainActor
final class VecwayAppDelegate: NSObject, UIApplicationDelegate {
    weak var pushManager: NativePushManager?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        pushManager?.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        pushManager?.didFailToRegisterForRemoteNotifications(error: error)
    }
}

@main
struct VecwayApp: App {
    @UIApplicationDelegateAdaptor(VecwayAppDelegate.self) private var appDelegate
    @StateObject private var controller = AppController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(controller: controller)
                .onAppear {
                    appDelegate.pushManager = controller.pushManager
                }
                .onOpenURL { url in
                    controller.handleIncomingURL(url)
                }
                .onChange(of: scenePhase) { newPhase in
                    controller.handleScenePhaseChange(newPhase)
                }
        }
    }
}
