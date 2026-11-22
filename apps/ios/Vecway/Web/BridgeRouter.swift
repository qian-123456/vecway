import Foundation
import UIKit
import WebKit

/// Breaks the retain cycle between `WKUserContentController` and `BridgeRouter`.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
        super.init()
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

struct ScannerOutcome: Sendable {
    let ok: Bool
    let error: String?
    let status: NativeEndpointStatus?
}

/// `WKScriptMessageHandler` bridging `window.__VECWAY_NATIVE__` calls to native Swift services.
/// SECURITY: Never exposes `deviceToken` to JS/WebStorage; strictly validates main-frame `vecway://app` origin.
@MainActor
final class BridgeRouter: NSObject, WKScriptMessageHandler {
    static let handlerName = "vecwayBridge"
    private static let maxHttpBodyBytes = 25 * 1024 * 1024

    weak var webView: WKWebView?

    private let endpointManager: EndpointManager
    private let sseBridge: SSEBridge
    private let voiceRecorder: NativeVoiceRecorder
    private let pushManager: NativePushManager
    private let openScannerHandler: @MainActor (AppController.PairScannerMode) async -> ScannerOutcome

    private var activeHttpTasks: [String: Task<Void, Never>] = [:]
    private var pendingSseOpenTasks: [String: (token: UUID, task: Task<Void, Never>)] = [:]

    init(
        endpointManager: EndpointManager,
        sseBridge: SSEBridge,
        voiceRecorder: NativeVoiceRecorder,
        pushManager: NativePushManager,
        openScannerHandler: @escaping @MainActor (AppController.PairScannerMode) async -> ScannerOutcome
    ) {
        self.endpointManager = endpointManager
        self.sseBridge = sseBridge
        self.voiceRecorder = voiceRecorder
        self.pushManager = pushManager
        self.openScannerHandler = openScannerHandler
        super.init()
    }

    // MARK: - Native -> JS Push Notifications

    func notifyConnectionStatus(_ status: NativeEndpointStatus) {
        guard let statusObj = encodeToJSONObject(status) else { return }
        dispatchToJS([
            "type": "connectionStatus",
            "status": statusObj,
        ])
    }

    func notifyForegroundResync() {
        dispatchToJS([
            "type": "foregroundResync",
        ])
    }

    func notifyKeyboard(height: Double, durationMs: Int) {
        let safeHeight = height.isFinite ? max(0.0, height) : 0.0
        dispatchToJS([
            "type": "keyboard",
            "height": safeHeight,
            "durationMs": max(0, durationMs),
        ])
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == Self.handlerName else { return }
        handleMessage(message)
    }

    private func handleMessage(_ message: WKScriptMessage) {
        // SECURITY: Reject messages from subframes (e.g. VisualizeBlock sandboxed iframes) or untrusted origins.
        guard message.frameInfo.isMainFrame,
              let originURL = message.frameInfo.request.url,
              originURL.scheme?.lowercased() == AppSchemeHandler.scheme,
              originURL.host?.lowercased() == AppSchemeHandler.appHost else {
            return
        }

        guard let payload = message.body as? [String: Any],
              let action = payload["action"] as? String else {
            return
        }

        let callId = payload["callId"] as? String

        switch action {
        case "httpRequest":
            guard let callId, let reqDict = payload["req"] as? [String: Any] else { return }
            handleHttpRequest(callId: callId, reqDict: reqDict)

        case "httpCancel":
            if let reqId = payload["reqId"] as? String {
                activeHttpTasks.removeValue(forKey: reqId)?.cancel()
            }

        case "sseOpen":
            guard let streamId = payload["streamId"] as? String,
                  let urlPath = payload["url"] as? String else { return }
            handleSseOpen(streamId: streamId, path: urlPath)

        case "sseClose":
            if let streamId = payload["streamId"] as? String {
                pendingSseOpenTasks.removeValue(forKey: streamId)?.task.cancel()
                sseBridge.close(streamId: streamId)
            }

        case "getConnectionStatus":
            guard let callId else { return }
            let status = endpointManager.currentStatus()
            replyOK(callId: callId, value: encodeToJSONObject(status) ?? [:])

        case "openPairScanner":
            guard let callId else { return }
            let rawMode = payload["mode"] as? String ?? ""
            let mode = AppController.PairScannerMode(rawValue: rawMode) ?? .scan
            Task {
                let outcome = await openScannerHandler(mode)
                var dict: [String: Any] = ["ok": outcome.ok]
                if let error = outcome.error {
                    dict["error"] = error
                }
                if let status = outcome.status, let encoded = encodeToJSONObject(status) {
                    dict["status"] = encoded
                }
                replyOK(callId: callId, value: dict)
            }

        case "updateEndpoints":
            guard let callId else { return }
            let rawEndpoints = payload["endpoints"] as? [String: Any] ?? [:]
            handleUpdateEndpoints(callId: callId, raw: rawEndpoints)


        case "switchChannel":
            guard let callId else { return }
            handleSwitchChannel(callId: callId, payload: payload)
        case "reprobeConnection":
            guard let callId else { return }
            Task {
                let status = await endpointManager.reprobeConnection()
                replyOK(callId: callId, value: encodeToJSONObject(status) ?? [:])
            }

        case "unpair":
            guard let callId else { return }
            Task {
                do {
                    try await endpointManager.unpair()
                    replyOK(callId: callId, value: NSNull())
                } catch {
                    replyError(callId: callId, message: error.localizedDescription)
                }
            }

        case "audioStart":
            guard let callId else { return }
            Task {
                do {
                    try await voiceRecorder.startRecording()
                    replyOK(callId: callId, value: NSNull())
                } catch {
                    replyError(callId: callId, message: error.localizedDescription)
                }
            }

        case "audioStopAndTranscribe":
            guard let callId else { return }
            Task {
                do {
                    let text = try await voiceRecorder.stopAndTranscribe()
                    replyOK(callId: callId, value: ["text": text])
                } catch {
                    replyError(callId: callId, message: error.localizedDescription)
                }
            }

        case "audioCancel":
            guard let callId else { return }
            voiceRecorder.cancelRecording()
            replyOK(callId: callId, value: NSNull())

        case "haptic":
            handleHaptic(payload)

        case "pushGetStatus":
            guard let callId else { return }
            Task {
                let status = await pushManager.getStatus()
                replyOK(callId: callId, value: encodeToJSONObject(status) ?? [:])
            }

        case "pushEnable":
            guard let callId else { return }
            Task {
                do {
                    try await pushManager.enable()
                    replyOK(callId: callId, value: NSNull())
                } catch {
                    replyError(callId: callId, message: error.localizedDescription)
                }
            }

        case "pushDisable":
            guard let callId else { return }
            Task {
                await pushManager.disable()
                replyOK(callId: callId, value: NSNull())
            }

        default:
            if let callId {
                replyError(callId: callId, message: "未知原生桥接操作：\(action)")
            }
        }
    }

    // MARK: - Action Handlers

    private func handleHttpRequest(callId: String, reqDict: [String: Any]) {
        guard let reqId = reqDict["id"] as? String,
              let method = reqDict["method"] as? String,
              let path = reqDict["path"] as? String else {
            replyError(callId: callId, message: "无效的原生 HTTP 请求参数")
            return
        }

        let headers = reqDict["headers"] as? [String: String]
        let timeoutMs = reqDict["timeoutMs"] as? Int

        let bodyData: Data?
        if let bodyBase64 = reqDict["bodyBase64"] as? String, !bodyBase64.isEmpty {
            guard let decoded = Data(base64Encoded: bodyBase64) else {
                replyError(callId: callId, message: "请求体 Base64 编码无效")
                return
            }
            guard decoded.count <= Self.maxHttpBodyBytes else {
                replyError(callId: callId, message: "请求体超过大小限制")
                return
            }
            bodyData = decoded
        } else {
            bodyData = nil
        }

        activeHttpTasks.removeValue(forKey: reqId)?.cancel()

        let task = Task { [weak self] in
            guard let self else { return }
            defer { self.activeHttpTasks.removeValue(forKey: reqId) }
            do {
                let response = try await self.endpointManager.performRequest(
                    method: method,
                    path: path,
                    headers: headers,
                    body: bodyData,
                    timeoutMs: timeoutMs
                )
                if Task.isCancelled {
                    self.replyError(callId: callId, message: "Aborted", name: "AbortError")
                    return
                }
                var replyPayload: [String: Any] = [
                    "status": response.status,
                    "headers": response.headers,
                ]
                if Self.isTextContentType(headers: response.headers),
                   let text = String(data: response.body, encoding: .utf8) {
                    replyPayload["bodyText"] = text
                } else {
                    replyPayload["bodyBase64"] = response.body.base64EncodedString()
                }
                self.replyOK(callId: callId, value: replyPayload)
            } catch is CancellationError {
                self.replyError(callId: callId, message: "Aborted", name: "AbortError")
            } catch let error as TransportError {
                if case .cancelled = error {
                    self.replyError(callId: callId, message: "Aborted", name: "AbortError")
                } else {
                    self.replyError(callId: callId, message: error.localizedDescription)
                }
            } catch {
                self.replyError(callId: callId, message: error.localizedDescription)
            }
        }
        activeHttpTasks[reqId] = task
    }

    private func handleSseOpen(streamId: String, path: String) {
        let openToken = UUID()
        pendingSseOpenTasks.removeValue(forKey: streamId)?.task.cancel()

        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.pendingSseOpenTasks[streamId]?.token == openToken {
                    self.pendingSseOpenTasks.removeValue(forKey: streamId)
                }
            }
            if Task.isCancelled { return }

            let status = self.endpointManager.currentStatus()
            if let mismatch = status.pinMismatch {
                self.dispatchSseError(
                    streamId: streamId,
                    message: PinMismatchError(mismatch: mismatch).localizedDescription
                )
                return
            }
            guard status.paired else {
                self.dispatchSseError(streamId: streamId, message: "尚未配对电脑")
                return
            }

            var active = self.endpointManager.activeConnection()
            if active == nil {
                _ = await self.endpointManager.reprobeConnection()
                if Task.isCancelled { return }
                if let mismatch = self.endpointManager.currentStatus().pinMismatch {
                    self.dispatchSseError(
                        streamId: streamId,
                        message: PinMismatchError(mismatch: mismatch).localizedDescription
                    )
                    return
                }
                active = self.endpointManager.activeConnection()
            }

            if Task.isCancelled { return }

            guard let connection = active else {
                self.dispatchSseError(streamId: streamId, message: "无法连接到电脑上的 Vecway 服务")
                return
            }

            let callbacks = SSEStreamCallbacks(
                onOpen: { [weak self] in
                    Task { @MainActor in
                        self?.dispatchToJS([
                            "type": "sse",
                            "streamId": streamId,
                            "kind": "open",
                        ])
                    }
                },
                onEvent: { [weak self] eventType, data in
                    Task { @MainActor in
                        self?.dispatchToJS([
                            "type": "sse",
                            "streamId": streamId,
                            "kind": "event",
                            "eventType": eventType,
                            "data": data,
                        ])
                    }
                },
                onError: { [weak self] message in
                    Task { @MainActor in
                        self?.dispatchSseError(streamId: streamId, message: message)
                    }
                },
                onUnauthorized: { [weak self] in
                    self?.endpointManager.markUnauthorized()
                },
                onPinMismatch: { [weak self] mismatch in
                    self?.endpointManager.recordPinMismatch(mismatch)
                }
            )

            self.sseBridge.open(
                streamId: streamId,
                channel: connection.channel,
                baseURL: connection.url,
                path: path,
                bearerToken: connection.credentials.deviceToken,
                expectedCertSha256: connection.credentials.pinnedCertSha256,
                callbacks: callbacks
            )
        }
        pendingSseOpenTasks[streamId] = (token: openToken, task: task)
    }

    private func handleUpdateEndpoints(callId: String, raw: [String: Any]) {
        func extractPatch(key: String) -> String?? {
            guard raw.keys.contains(key) else { return nil }
            if raw[key] is NSNull {
                return .some(nil)
            }
            if let str = raw[key] as? String {
                return .some(str)
            }
            return nil
        }

        let certSha256 = raw["certSha256"] as? String
        let patch = EndpointUpdatePatch(
            lanTls: extractPatch(key: "lanTls"),
            ipv6: extractPatch(key: "ipv6"),
            tunnel: extractPatch(key: "tunnel"),
            certSha256: certSha256
        )

        Task {
            do {
                let status = try await endpointManager.updateEndpoints(patch)
                replyOK(callId: callId, value: encodeToJSONObject(status) ?? [:])
            } catch {
                replyError(callId: callId, message: error.localizedDescription)
            }
        }
    }

    private func handleSwitchChannel(callId: String, payload: [String: Any]) {
        let targetChannel: NativeChannel?
        if let rawChannel = payload["channel"] as? String {
            let trimmed = rawChannel.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || trimmed == "auto" {
                targetChannel = nil
            } else if let parsed = NativeChannel(rawValue: trimmed) {
                targetChannel = parsed
            } else {
                replyError(callId: callId, message: "不支持的通道类型：\(trimmed)")
                return
            }
        } else if payload["channel"] == nil || payload["channel"] is NSNull {
            targetChannel = nil
        } else {
            replyError(callId: callId, message: "无效的通道切换参数")
            return
        }

        Task {
            do {
                let status = try await endpointManager.switchChannel(targetChannel)
                replyOK(callId: callId, value: encodeToJSONObject(status) ?? [:])
            } catch {
                replyError(callId: callId, message: error.localizedDescription)
            }
        }
    }

    private static func isTextContentType(headers: [String: String]) -> Bool {
        guard let raw = headers.first(where: { $0.key.lowercased() == "content-type" })?.value else {
            return false
        }
        let mediaType = raw.split(separator: ";", maxSplits: 1).first?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        return mediaType.hasPrefix("text/")
            || mediaType == "application/json"
            || mediaType.hasSuffix("+json")
            || mediaType.hasSuffix("+xml")
    }

    private func handleHaptic(_ payload: [String: Any]) {
        guard let kind = payload["kind"] as? String else { return }
        switch kind {
        case "impact":
            let styleStr = payload["style"] as? String ?? "light"
            let style: UIImpactFeedbackGenerator.FeedbackStyle
            switch styleStr {
            case "heavy": style = .heavy
            case "medium": style = .medium
            default: style = .light
            }
            let generator = UIImpactFeedbackGenerator(style: style)
            generator.prepare()
            generator.impactOccurred()

        case "notification":
            let typeStr = payload["notificationType"] as? String ?? "success"
            let feedbackType: UINotificationFeedbackGenerator.FeedbackType
            switch typeStr {
            case "warning": feedbackType = .warning
            case "error": feedbackType = .error
            default: feedbackType = .success
            }
            let generator = UINotificationFeedbackGenerator()
            generator.prepare()
            generator.notificationOccurred(feedbackType)

        case "selection":
            let generator = UISelectionFeedbackGenerator()
            generator.prepare()
            generator.selectionChanged()

        default:
            break
        }
    }

    // MARK: - JS Dispatch Helpers

    private func dispatchSseError(streamId: String, message: String) {
        dispatchToJS([
            "type": "sse",
            "streamId": streamId,
            "kind": "error",
            "message": message,
        ])
    }

    private func replyOK(callId: String, value: Any) {
        dispatchToJS([
            "type": "reply",
            "callId": callId,
            "ok": true,
            "value": value,
        ])
    }

    private func replyError(callId: String, message: String, name: String = "Error") {
        dispatchToJS([
            "type": "reply",
            "callId": callId,
            "ok": false,
            "error": [
                "name": name,
                "message": message,
            ],
        ])
    }

    private func dispatchToJS(_ object: [String: Any]) {
        guard let webView else { return }
        webView.callAsyncJavaScript(
            "window.__VECWAY_NATIVE_DISPATCH__ && window.__VECWAY_NATIVE_DISPATCH__(payload);",
            arguments: ["payload": object],
            in: nil,
            in: .page,
            completionHandler: nil
        )
    }

    private func encodeToJSONObject<T: Encodable>(_ value: T) -> Any? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [])
    }

    // MARK: - Document-Start Injection Script

    static func makeInjectionScript(appVersion: String) -> String {
        let escapedVersion = appVersion
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return """
        (function () {
          if (window.__VECWAY_NATIVE__) return;

          var handlerName = "\(handlerName)";
          var rpcSeq = 0;
          var sseSeq = 0;
          var pending = new Map();
          var sseStreams = new Map();
          var statusListeners = new Set();
          var foregroundListeners = new Set();
          var keyboardListeners = new Set();
          var lastKeyboard = { height: 0, durationMs: 0 };

          function post(msg) {
            var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers[handlerName];
            if (!handler) {
              throw new Error("Vecway native bridge unavailable");
            }
            handler.postMessage(msg);
          }

          function makeAbortError() {
            var err = new Error("Aborted");
            err.name = "AbortError";
            return err;
          }

          function callNative(action, payload, options) {
            return new Promise(function (resolve, reject) {
              var signal = options && options.signal;
              if (signal && signal.aborted) {
                reject(makeAbortError());
                return;
              }

              var callId = "rpc_" + (++rpcSeq);
              var onAbort = null;
              function cleanup() {
                if (signal && onAbort) {
                  signal.removeEventListener("abort", onAbort);
                }
              }

              pending.set(callId, {
                resolve: function (val) {
                  cleanup();
                  resolve(val);
                },
                reject: function (err) {
                  cleanup();
                  reject(err);
                }
              });

              if (signal) {
                onAbort = function () {
                  if (pending.delete(callId)) {
                    cleanup();
                    if (options && options.cancelReqId) {
                      try { post({ action: "httpCancel", reqId: options.cancelReqId }); } catch (_) {}
                    }
                    reject(makeAbortError());
                  }
                };
                signal.addEventListener("abort", onAbort, { once: true });
              }

              try {
                var body = Object.assign({ action: action, callId: callId }, payload || {});
                post(body);
              } catch (err) {
                pending.delete(callId);
                cleanup();
                reject(err);
              }
            });
          }

          Object.defineProperty(window, "__VECWAY_NATIVE_DISPATCH__", {
            value: function (msg) {
              if (!msg || typeof msg !== "object") return;
              if (msg.type === "reply") {
                var entry = pending.get(msg.callId);
                if (!entry) return;
                pending.delete(msg.callId);
                if (msg.ok) {
                  entry.resolve(msg.value);
                } else {
                  var info = msg.error || {};
                  var err = new Error(info.message || "Native bridge error");
                  if (info.name) err.name = info.name;
                  entry.reject(err);
                }
                return;
              }
              if (msg.type === "sse") {
                var handlers = sseStreams.get(msg.streamId);
                if (!handlers) return;
                if (msg.kind === "open") {
                  if (typeof handlers.onOpen === "function") handlers.onOpen();
                } else if (msg.kind === "event") {
                  if (typeof handlers.onEvent === "function") handlers.onEvent(msg.eventType || "message", msg.data || "");
                } else if (msg.kind === "error") {
                  sseStreams.delete(msg.streamId);
                  if (typeof handlers.onError === "function") handlers.onError(msg.message);
                }
                return;
              }
              if (msg.type === "connectionStatus") {
                statusListeners.forEach(function (cb) {
                  try { cb(msg.status); } catch (_) {}
                });
                return;
              }
              if (msg.type === "foregroundResync") {
                foregroundListeners.forEach(function (cb) {
                  try { cb(); } catch (_) {}
                });
                return;
              }
              if (msg.type === "keyboard") {
                lastKeyboard = {
                  height: typeof msg.height === "number" ? msg.height : 0,
                  durationMs: typeof msg.durationMs === "number" ? msg.durationMs : 0
                };
                keyboardListeners.forEach(function (cb) {
                  try { cb(lastKeyboard); } catch (_) {}
                });
              }
            },
            writable: false,
            configurable: false,
            enumerable: false
          });

          var bridge = Object.freeze({
            platform: "ios",
            appVersion: "\(escapedVersion)",
            httpRequest: function (req, signal) {
              var reqId = (req && req.id) ? String(req.id) : ("req_" + (++rpcSeq));
              var normalizedReq = Object.assign({}, req, { id: reqId });
              return callNative("httpRequest", { req: normalizedReq }, { signal: signal, cancelReqId: reqId });
            },
            openSse: function (url, handlers) {
              var streamId = "sse_" + (++sseSeq);
              sseStreams.set(streamId, handlers || {});
              var closed = false;
              try {
                post({ action: "sseOpen", streamId: streamId, url: String(url || "") });
              } catch (err) {
                sseStreams.delete(streamId);
                if (handlers && typeof handlers.onError === "function") {
                  handlers.onError(err && err.message ? err.message : "SSE start failed");
                }
              }
              return function close() {
                if (closed) return;
                closed = true;
                sseStreams.delete(streamId);
                try { post({ action: "sseClose", streamId: streamId }); } catch (_) {}
              };
            },
            getConnectionStatus: function () {
              return callNative("getConnectionStatus");
            },
            openPairScanner: function (opts) {
              return callNative("openPairScanner", opts && typeof opts === "object" ? { mode: opts.mode } : {});
            },
            updateEndpoints: function (endpoints) {
              return callNative("updateEndpoints", { endpoints: endpoints || {} });
            },
            switchChannel: function (channel) {
              return callNative("switchChannel", { channel: channel === undefined ? null : channel });
            },
            reprobeConnection: function () {
              return callNative("reprobeConnection");
            },
            unpair: function () {
              return callNative("unpair");
            },
            onConnectionStatusChange: function (cb) {
              if (typeof cb !== "function") return function () {};
              statusListeners.add(cb);
              return function () { statusListeners.delete(cb); };
            },
            onForegroundResync: function (cb) {
              if (typeof cb !== "function") return function () {};
              foregroundListeners.add(cb);
              return function () { foregroundListeners.delete(cb); };
            },
            onKeyboardChange: function (cb) {
              if (typeof cb !== "function") return function () {};
              keyboardListeners.add(cb);
              if (lastKeyboard.height > 0) {
                try { cb(lastKeyboard); } catch (_) {}
              }
              return function () { keyboardListeners.delete(cb); };
            },
            audio: Object.freeze({
              startRecording: function () { return callNative("audioStart"); },
              stopAndTranscribe: function () { return callNative("audioStopAndTranscribe"); },
              cancelRecording: function () { return callNative("audioCancel"); }
            }),
            haptics: Object.freeze({
              impact: function (style) {
                try { post({ action: "haptic", kind: "impact", style: style || "light" }); } catch (_) {}
              },
              notification: function (type) {
                try { post({ action: "haptic", kind: "notification", notificationType: type || "success" }); } catch (_) {}
              },
              selection: function () {
                try { post({ action: "haptic", kind: "selection" }); } catch (_) {}
              }
            }),
            push: Object.freeze({
              getStatus: function () { return callNative("pushGetStatus"); },
              enable: function () { return callNative("pushEnable"); },
              disable: function () { return callNative("pushDisable"); }
            })
          });

          Object.defineProperty(window, "__VECWAY_NATIVE__", {
            value: bridge,
            writable: false,
            configurable: false,
            enumerable: true
          });
        })();
        """
    }
}
