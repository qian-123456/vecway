import SwiftUI

/// Root container rendering the full-bleed bundled `AppWebView`,
/// overlaid with the full-screen `PinMismatchView` hard blocker whenever a certificate mismatch occurs,
/// and presenting the native `QRScannerView` pairing sheet on demand or via `vecway://pair` deep links.
struct RootView: View {
    @ObservedObject var controller: AppController

    var body: some View {
        ZStack {
            AppWebView(controller: controller)
                .ignoresSafeArea()

            if let mismatch = controller.status.pinMismatch {
                PinMismatchView(
                    mismatch: mismatch,
                    onRescan: {
                        controller.openScannerManually()
                    },
                    onUnpair: {
                        controller.unpair()
                    }
                )
                .transition(.opacity)
                .zIndex(100)
            }
        }
        .sheet(
            isPresented: $controller.isScannerPresented,
            onDismiss: {
                controller.handleScannerDismissed()
            }
        ) {
            QRScannerView(
                controller: controller,
                initialPayload: controller.pendingDeepLinkPayload
            )
        }
        .alert(
            "配对链接无效",
            isPresented: Binding(
                get: { controller.deepLinkError != nil },
                set: { presented in
                    if !presented {
                        controller.deepLinkError = nil
                    }
                }
            )
        ) {
            Button("好", role: .cancel) {
                controller.deepLinkError = nil
            }
        } message: {
            Text(controller.deepLinkError ?? "")
        }
    }
}
