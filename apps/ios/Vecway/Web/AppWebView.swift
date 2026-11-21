import SwiftUI
import UIKit
import WebKit

/// Full-bleed `WKWebView` hosting the bundled `src-mobile` app via `vecway://app/`.
/// Safe-area insets are delegated to CSS `env(safe-area-inset-*)` + `viewport-fit=cover`.
struct AppWebView: UIViewRepresentable {
    @ObservedObject var controller: AppController

    func makeCoordinator() -> Coordinator {
        Coordinator(controller: controller)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(controller.schemeHandler, forURLScheme: AppSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()

        let userContentController = WKUserContentController()
        let appVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.2.0"
        let bridgeScript = WKUserScript(
            source: BridgeRouter.makeInjectionScript(appVersion: appVersion),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        userContentController.addUserScript(bridgeScript)
        userContentController.add(
            WeakScriptMessageHandler(controller.bridgeRouter),
            name: BridgeRouter.handlerName
        )
        config.userContentController = userContentController

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = true

        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif

        controller.bridgeRouter.webView = webView

        if let startURL = URL(string: "\(AppSchemeHandler.scheme)://\(AppSchemeHandler.appHost)/index.html") {
            webView.load(URLRequest(url: startURL))
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // Keep the live SPA WebView mounted without reloading on SwiftUI state updates.
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: BridgeRouter.handlerName)
        uiView.navigationDelegate = nil
        uiView.uiDelegate = nil
    }

    // MARK: - Coordinator

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let controller: AppController

        init(controller: AppController) {
            self.controller = controller
            super.init()
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            let scheme = url.scheme?.lowercased() ?? ""

            // Allow bundled app origin and harmless inline/sandboxed iframe schemes.
            if scheme == AppSchemeHandler.scheme {
                if url.host?.lowercased() == AppSchemeHandler.appHost {
                    decisionHandler(.allow)
                    return
                }
                if url.host?.lowercased() == "pair" {
                    Task { @MainActor in
                        controller.handleIncomingURL(url)
                    }
                    decisionHandler(.cancel)
                    return
                }
                decisionHandler(.cancel)
                return
            }

            if scheme == "about" || scheme == "data" || scheme == "blob" {
                decisionHandler(.allow)
                return
            }

            // SECURITY: Open external http/https links in Safari; never load untrusted origins in app WebView.
            if scheme == "http" || scheme == "https" {
                if navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true {
                    UIApplication.shared.open(url)
                    decisionHandler(.cancel)
                    return
                }
            }

            // Allow tel:/mailto: via system handler.
            if scheme == "mailto" || scheme == "tel" {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }

            decisionHandler(.cancel)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                UIApplication.shared.open(url)
            }
            return nil
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
            presentAlert(alert, fallback: completionHandler)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
            presentAlert(alert, fallback: { completionHandler(false) })
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (String?) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { field in
                field.text = defaultText
            }
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in
                completionHandler(alert.textFields?.first?.text)
            })
            presentAlert(alert, fallback: { completionHandler(nil) })
        }

        private func presentAlert(_ alert: UIAlertController, fallback: @escaping () -> Void) {
            guard let presenter = Self.topViewController() else {
                fallback()
                return
            }
            presenter.present(alert, animated: true)
        }

        private static func topViewController() -> UIViewController? {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let keyWindow = scenes
                .flatMap(\.windows)
                .first { $0.isKeyWindow }
            var current = keyWindow?.rootViewController
            while let presented = current?.presentedViewController {
                current = presented
            }
            return current
        }
    }
}
