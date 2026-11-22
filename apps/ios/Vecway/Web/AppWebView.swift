import ObjectiveC.runtime
import SwiftUI
import UIKit
import WebKit

/// `WKWebView` subclass that suppresses the default iOS form accessory bar (`∧ ∨ 完成`)
/// and suppresses the native selection edit callout on non-editable web content while
/// preserving native edit menus inside `<input>`, `<textarea>`, and `contenteditable` elements.
@MainActor
private final class VecwayWebView: WKWebView {
    private static var patchedContentClasses: [ObjectIdentifier: AnyClass] = [:]
    private weak var patchedContentView: UIView?

    /// Updated from the main-frame selection policy script whenever focus/selection enters or leaves an editable field.
    var allowNativeEditMenu: Bool = false

    override var inputAccessoryView: UIView? {
        nil
    }

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        patchContentViewIfPresent()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        patchContentViewIfPresent()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        patchContentViewIfPresent()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        patchContentViewIfPresent()
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if !allowNativeEditMenu && !(sender is UICommand) {
            return false
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func buildMenu(with builder: UIMenuBuilder) {
        if !allowNativeEditMenu && builder.system == .context {
            Self.removeContextEditMenus(from: builder)
            return
        }
        super.buildMenu(with: builder)
    }

    private func patchContentViewIfPresent() {
        guard let contentView = scrollView.subviews.first(where: {
            String(describing: type(of: $0)).hasPrefix("WKContent")
        }) else {
            return
        }
        if patchedContentView === contentView {
            return
        }
        guard let originalClass: AnyClass = object_getClass(contentView) else {
            return
        }
        let originalName = String(cString: class_getName(originalClass))
        if originalName.hasSuffix("_VecwayContentView") {
            patchedContentView = contentView
            return
        }
        guard let subclass = Self.patchedContentSubclass(for: originalClass, originalName: originalName) else {
            return
        }
        object_setClass(contentView, subclass)
        patchedContentView = contentView
    }

    private static func shouldAllowNativeEditMenu(for receiver: AnyObject) -> Bool {
        var current: UIView? = receiver as? UIView
        while let view = current {
            if let webView = view as? VecwayWebView {
                return webView.allowNativeEditMenu
            }
            current = view.superview
        }
        return false
    }

    private static func removeContextEditMenus(from builder: UIMenuBuilder) {
        builder.remove(menu: .standardEdit)
        builder.remove(menu: .replace)
        builder.remove(menu: .share)
        builder.remove(menu: .lookup)
        builder.remove(menu: .speech)
        builder.remove(menu: .format)
        builder.remove(menu: .textStyle)
        builder.remove(menu: .learn)
        if #available(iOS 17.0, *) {
            builder.remove(menu: .autoFill)
        }
    }

    private static func patchedContentSubclass(for originalClass: AnyClass, originalName: String) -> AnyClass? {
        let key = ObjectIdentifier(originalClass)
        if let cached = patchedContentClasses[key] {
            return cached
        }

        let subclassName = "\(originalName)_VecwayContentView"
        if let existing = NSClassFromString(subclassName) {
            patchedContentClasses[key] = existing
            return existing
        }

        guard let newClass = objc_allocateClassPair(originalClass, subclassName, 0) else {
            return nil
        }

        let accessorySelector = #selector(getter: UIResponder.inputAccessoryView)
        let accessoryBlock: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
        let accessoryImp = imp_implementationWithBlock(accessoryBlock)
        if let method = class_getInstanceMethod(originalClass, accessorySelector),
           let types = method_getTypeEncoding(method) {
            class_addMethod(newClass, accessorySelector, accessoryImp, types)
        } else {
            class_addMethod(newClass, accessorySelector, accessoryImp, "@@:")
        }

        let canPerformSelector = #selector(UIResponder.canPerformAction(_:withSender:))
        let canPerformMethod = class_getInstanceMethod(originalClass, canPerformSelector)
        typealias CanPerformIMP = @convention(c) (AnyObject, Selector, Selector, AnyObject?) -> Bool
        let superCanPerform = canPerformMethod.map { unsafeBitCast(method_getImplementation($0), to: CanPerformIMP.self) }
        let canPerformBlock: @convention(block) (AnyObject, Selector, AnyObject?) -> Bool = { receiver, action, sender in
            let allowed = MainActor.assumeIsolated {
                Self.shouldAllowNativeEditMenu(for: receiver) || (sender is UICommand)
            }
            guard allowed else { return false }
            return superCanPerform?(receiver, canPerformSelector, action, sender) ?? false
        }
        let canPerformImp = imp_implementationWithBlock(canPerformBlock)
        if let canPerformMethod, let types = method_getTypeEncoding(canPerformMethod) {
            class_addMethod(newClass, canPerformSelector, canPerformImp, types)
        } else {
            class_addMethod(newClass, canPerformSelector, canPerformImp, "B@::@")
        }

        let buildMenuSelector = #selector(UIResponder.buildMenu(with:))
        let buildMenuMethod = class_getInstanceMethod(originalClass, buildMenuSelector)
        typealias BuildMenuIMP = @convention(c) (AnyObject, Selector, UIMenuBuilder) -> Void
        let superBuildMenu = buildMenuMethod.map { unsafeBitCast(method_getImplementation($0), to: BuildMenuIMP.self) }
        let buildMenuBlock: @convention(block) (AnyObject, UIMenuBuilder) -> Void = { receiver, builder in
            let suppress = MainActor.assumeIsolated {
                !Self.shouldAllowNativeEditMenu(for: receiver) && builder.system == .context
            }
            if suppress {
                MainActor.assumeIsolated {
                    Self.removeContextEditMenus(from: builder)
                }
                return
            }
            superBuildMenu?(receiver, buildMenuSelector, builder)
        }
        let buildMenuImp = imp_implementationWithBlock(buildMenuBlock)
        if let buildMenuMethod, let types = method_getTypeEncoding(buildMenuMethod) {
            class_addMethod(newClass, buildMenuSelector, buildMenuImp, types)
        } else {
            class_addMethod(newClass, buildMenuSelector, buildMenuImp, "v@:@")
        }

        objc_registerClassPair(newClass)

        patchedContentClasses[key] = newClass
        return newClass
    }
}

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
        let selectionPolicyScript = WKUserScript(
            source: Coordinator.selectionPolicyScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        userContentController.addUserScript(selectionPolicyScript)
        userContentController.add(
            WeakScriptMessageHandler(context.coordinator),
            name: Coordinator.selectionPolicyHandlerName
        )
        config.userContentController = userContentController

        let webView = VecwayWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.delegate = context.coordinator
        context.coordinator.attach(to: webView)
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
        coordinator.detach()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: BridgeRouter.handlerName)
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.selectionPolicyHandlerName)
        uiView.navigationDelegate = nil
        uiView.uiDelegate = nil
        uiView.scrollView.delegate = nil
    }

    // MARK: - Coordinator

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, UIScrollViewDelegate, WKScriptMessageHandler {
        static let selectionPolicyHandlerName = "vecwaySelectionPolicy"
        static let selectionPolicyScript = """
        (() => {
          if (window.__VECWAY_SELECTION_POLICY__) return;
          window.__VECWAY_SELECTION_POLICY__ = true;
          const handlerName = "\(selectionPolicyHandlerName)";
          let lastEditable = null;
          function postEditable(editable) {
            const next = Boolean(editable);
            if (next === lastEditable) return;
            lastEditable = next;
            try {
              window.webkit?.messageHandlers?.[handlerName]?.postMessage({ editable: next });
            } catch {}
          }
          function isEditableElement(node) {
            let el = node && node.nodeType === 1 ? node : node?.parentElement;
            while (el) {
              if (el.isContentEditable) return true;
              const tag = el.tagName;
              if (tag === "TEXTAREA") return !el.readOnly && !el.disabled;
              if (tag === "INPUT") {
                if (el.readOnly || el.disabled) return false;
                const type = (el.type || "text").toLowerCase();
                return !["button", "checkbox", "radio", "submit", "reset", "file", "image", "range", "color", "hidden"].includes(type);
              }
              el = el.parentElement;
            }
            return false;
          }
          document.addEventListener("focusin", (e) => {
            postEditable(isEditableElement(e.target) || isEditableElement(document.activeElement));
          }, true);
          document.addEventListener("focusout", () => {
            setTimeout(() => {
              postEditable(isEditableElement(document.activeElement));
            }, 0);
          }, true);
          document.addEventListener("touchstart", (e) => {
            const targetEl = e.target && e.target.nodeType === 1 ? e.target : e.target?.parentElement;
            if (isEditableElement(targetEl)) {
              postEditable(true);
            } else if (!isEditableElement(document.activeElement) || !targetEl?.closest?.("button, a, [role='button']")) {
              postEditable(false);
            }
          }, { capture: true, passive: true });
          document.addEventListener("selectionchange", () => {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
              const anchor = sel.anchorNode;
              const active = document.activeElement;
              if (isEditableElement(active)) {
                const anchorEl = anchor && anchor.nodeType === 1 ? anchor : anchor?.parentElement;
                const insideActive = !anchorEl || anchorEl === active || anchorEl.contains(active) || active.contains(anchorEl);
                postEditable(insideActive);
                return;
              }
              postEditable(isEditableElement(anchor));
              return;
            }
            postEditable(isEditableElement(document.activeElement));
          }, true);
        })();
        """

        private let controller: AppController
        private weak var webView: WKWebView?
        private var isObservingKeyboard = false
        private var lastKeyboardHeight: Double = 0

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == Self.selectionPolicyHandlerName,
                  message.frameInfo.isMainFrame,
                  let originURL = message.frameInfo.request.url,
                  originURL.scheme?.lowercased() == AppSchemeHandler.scheme,
                  originURL.host?.lowercased() == AppSchemeHandler.appHost,
                  let payload = message.body as? [String: Any],
                  let editable = payload["editable"] as? Bool,
                  let vecwayWebView = webView as? VecwayWebView else {
                return
            }
            vecwayWebView.allowNativeEditMenu = editable
        }

        init(controller: AppController) {
            self.controller = controller
            super.init()
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        func attach(to webView: WKWebView) {
            self.webView = webView
            guard !isObservingKeyboard else { return }
            isObservingKeyboard = true
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleKeyboardWillChangeFrame(_:)),
                name: UIResponder.keyboardWillChangeFrameNotification,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleKeyboardWillHide(_:)),
                name: UIResponder.keyboardWillHideNotification,
                object: nil
            )
        }

        func detach() {
            if isObservingKeyboard {
                NotificationCenter.default.removeObserver(self)
                isObservingKeyboard = false
            }
            webView = nil
        }

        // MARK: - UIScrollViewDelegate

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            if scrollView.contentOffset != .zero {
                scrollView.contentOffset = .zero
            }
        }

        // MARK: - Keyboard Frame Bridge

        @objc private func handleKeyboardWillChangeFrame(_ notification: Notification) {
            guard let userInfo = notification.userInfo,
                  let endFrameScreen = (userInfo[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else {
                return
            }
            let duration = (userInfo[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
            let durationMs = max(0, Int((duration * 1000.0).rounded()))

            guard let webView, let window = webView.window else { return }
            let endFrameInWindow = window.convert(endFrameScreen, from: nil as UIWindow?)
            let webViewFrameInWindow = webView.convert(webView.bounds, to: window)

            let isBottomDocked = endFrameInWindow.maxY >= webViewFrameInWindow.maxY - 4
                || abs(endFrameInWindow.maxY - window.bounds.maxY) <= 4

            let overlap: Double
            if endFrameInWindow.isEmpty
                || endFrameInWindow.height <= 0
                || !isBottomDocked
                || !webViewFrameInWindow.intersects(endFrameInWindow) {
                overlap = 0
            } else {
                let rawOverlap = max(0.0, Double(webViewFrameInWindow.maxY - endFrameInWindow.minY))
                overlap = min(Double(webViewFrameInWindow.height), rawOverlap)
            }

            emitKeyboardIfChanged(height: overlap, durationMs: durationMs)
        }

        @objc private func handleKeyboardWillHide(_ notification: Notification) {
            let duration = (notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
            let durationMs = max(0, Int((duration * 1000.0).rounded()))
            emitKeyboardIfChanged(height: 0, durationMs: durationMs)
        }

        private func emitKeyboardIfChanged(height: Double, durationMs: Int) {
            let clampedHeight = height.isFinite ? max(0.0, height) : 0.0
            if abs(clampedHeight - lastKeyboardHeight) < 0.5 {
                return
            }
            lastKeyboardHeight = clampedHeight
            controller.bridgeRouter.notifyKeyboard(height: clampedHeight, durationMs: durationMs)
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
