import CryptoKit
import Foundation
import Security

/// Structured TLS certificate pin mismatch payload shared with the WebView bridge & native hard-block UI.
public struct NativePinMismatch: Codable, Equatable, Hashable, Sendable {
    public let expectedSha256: String
    public let actualSha256: String
    public let host: String
    public let channel: NativeChannel

    public init(
        expectedSha256: String,
        actualSha256: String,
        host: String,
        channel: NativeChannel
    ) {
        self.expectedSha256 = expectedSha256
        self.actualSha256 = actualSha256
        self.host = host
        self.channel = channel
    }
}

/// Hard-blocking error raised whenever the peer leaf certificate DER SHA-256 differs from the pinned value.
public struct PinMismatchError: Error, LocalizedError, Equatable, Sendable {
    public let mismatch: NativePinMismatch

    public var expectedSha256: String { mismatch.expectedSha256 }
    public var actualSha256: String { mismatch.actualSha256 }
    public var host: String { mismatch.host }
    public var channel: NativeChannel { mismatch.channel }

    public init(mismatch: NativePinMismatch) {
        self.mismatch = mismatch
    }

    public init(expectedSha256: String, actualSha256: String, host: String, channel: NativeChannel) {
        self.mismatch = NativePinMismatch(
            expectedSha256: expectedSha256,
            actualSha256: actualSha256,
            host: host,
            channel: channel
        )
    }

    public var errorDescription: String? {
        "安全警告：服务器证书指纹不匹配（\(mismatch.host)）"
    }
}

public enum TransportError: Error, LocalizedError, Equatable, Sendable {
    case plaintextForbidden(String)
    case invalidURL(String)
    case missingCertificatePin(NativeChannel)
    case invalidCertificatePin
    case pinMismatch(NativePinMismatch)
    case unpaired
    case unreachable(String)
    case httpError(status: Int, message: String)
    case invalidResponse
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .plaintextForbidden:
            return "安全拦截：禁止通过明文 HTTP 发送请求或凭据"
        case .invalidURL(let raw):
            return "无效的请求地址：\(raw)"
        case .missingCertificatePin(let channel):
            return "安全拦截：\(channel.displayName) 缺少已锁定的证书指纹"
        case .invalidCertificatePin:
            return "本地锁定的证书指纹格式无效，请重新扫码配对"
        case .pinMismatch(let mismatch):
            return PinMismatchError(mismatch: mismatch).errorDescription
        case .unpaired:
            return "尚未配对电脑，请先扫码配对"
        case .unreachable(let reason):
            return reason.isEmpty ? "无法连接到电脑上的 Vecway 服务" : reason
        case .httpError(let status, let message):
            return message.isEmpty ? "服务器返回错误（HTTP \(status)）" : message
        case .invalidResponse:
            return "服务器返回了无法解析的响应"
        case .cancelled:
            return "请求已取消"
        }
    }
}

public struct TransportResponse: Equatable, Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data

    public init(status: Int, headers: [String: String], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }
}

public struct PairedDeviceInfo: Codable, Equatable, Sendable {
    public let id: String?
    public let name: String?

    public init(id: String? = nil, name: String? = nil) {
        self.id = id
        self.name = name
    }
}

public struct PairExchangeResponse: Codable, Equatable, Sendable {
    public let token: String
    public let device: PairedDeviceInfo?

    public init(token: String, device: PairedDeviceInfo? = nil) {
        self.token = token
        self.device = device
    }
}

/// Pure header sanitization and native credential/UA injection.
public enum HeaderSanitizer {
    private static let strippedExact: Set<String> = [
        "origin",
        "referer",
        "cookie",
        "authorization",
        "host",
        "user-agent",
    ]

    /// Strips browser/CSRF headers (`Origin`, `Referer`, `Cookie`, `Sec-Fetch-*`) and caller-supplied
    /// `Authorization`/`User-Agent`, then injects canonical `User-Agent` and optional `Authorization: Bearer`.
    public static func sanitize(
        headers: [String: String]?,
        bearerToken: String?,
        userAgent: String
    ) -> [String: String] {
        var result: [String: String] = [:]
        if let headers {
            for (key, value) in headers {
                let lower = key.lowercased()
                if strippedExact.contains(lower) || lower.hasPrefix("sec-fetch-") {
                    continue
                }
                result[key] = value
            }
        }
        result["User-Agent"] = userAgent
        if let token = bearerToken, !token.isEmpty {
            result["Authorization"] = "Bearer \(token)"
        }
        return result
    }
}

/// Cryptographic and URL security primitives shared by `PinnedTransport` and `SSEBridge`.
public enum TransportSecurity {
    /// Constant-time byte comparison to prevent timing leaks on SHA-256 digest verification.
    public static func constantTimeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
        guard lhs.count == rhs.count else { return false }
        var diff: UInt8 = 0
        for (a, b) in zip(lhs, rhs) {
            diff |= a ^ b
        }
        return diff == 0
    }

    /// Hard-blocks any non-HTTPS URL (`http://`, `ws://`, etc.) before touching a socket.
    public static func validateHTTPSURL(_ url: URL) throws {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" else {
            throw TransportError.plaintextForbidden(url.absoluteString)
        }
        guard let host = url.host, !host.isEmpty else {
            throw TransportError.invalidURL(url.absoluteString)
        }
    }

    /// Safely combines a validated `https://` endpoint base URL with a relative request path,
    /// preventing scheme downgrade, protocol-relative `//evil.com` host overrides, and header injection.
    public static func resolveEndpointURL(base: String, path: String) throws -> URL {
        guard let baseURL = URL(string: base) else {
            throw TransportError.invalidURL(base)
        }
        try validateHTTPSURL(baseURL)

        var cleanPath = path
        if cleanPath.hasPrefix("vecway://app/") {
            cleanPath = String(cleanPath.dropFirst("vecway://app".count))
        }
        if cleanPath.lowercased().hasPrefix("http://") || cleanPath.lowercased().hasPrefix("https://") {
            throw TransportError.plaintextForbidden(cleanPath)
        }
        guard cleanPath.hasPrefix("/"),
              !cleanPath.hasPrefix("//"),
              !cleanPath.contains("\\"),
              !cleanPath.contains("\r"),
              !cleanPath.contains("\n") else {
            throw TransportError.invalidURL(path)
        }

        let trimmedBase = base.hasSuffix("/") ? String(base.dropLast()) : base
        guard let resolved = URL(string: trimmedBase + cleanPath) else {
            throw TransportError.invalidURL(trimmedBase + cleanPath)
        }
        try validateHTTPSURL(resolved)
        guard resolved.host?.lowercased() == baseURL.host?.lowercased(),
              resolved.port == baseURL.port else {
            throw TransportError.invalidURL(path)
        }
        return resolved
    }

    /// Extracts index-0 leaf certificate DER bytes from `SecTrust` (exact match with Rust `tls.rs`).
    public static func leafCertificateDER(from trust: SecTrust) -> Data? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            return nil
        }
        return SecCertificateCopyData(leaf) as Data
    }

    /// Computes raw 32-byte SHA-256 digest of DER certificate bytes.
    public static func sha256Digest(of der: Data) -> Data {
        Data(SHA256.hash(data: der))
    }

    /// Verifies leaf certificate DER against expected 32-byte SHA-256 digest in constant time.
    /// Throws `PinMismatchError` on any mismatch.
    public static func verifyLeafCertificateDER(
        _ der: Data,
        expectedDigest: Data,
        expectedHex: String,
        host: String,
        channel: NativeChannel
    ) throws {
        let actualDigest = sha256Digest(of: der)
        guard expectedDigest.count == CertificateFingerprint.expectedByteCount,
              actualDigest.count == CertificateFingerprint.expectedByteCount,
              constantTimeEqual(actualDigest, expectedDigest) else {
            let actualHex = CertificateFingerprint.format(actualDigest)
            throw PinMismatchError(
                expectedSha256: expectedHex,
                actualSha256: actualHex,
                host: host,
                channel: channel
            )
        }
    }

    /// Builds canonical native User-Agent (`Vecway-iOS/0.2.0 (iPhone)` or `(iPad)`) without requiring `@MainActor`.
    public static func defaultUserAgent(appVersion: String? = nil) -> String {
        let version = appVersion
            ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
            ?? "0.2.0"
        let deviceFormFactor = detectDeviceFormFactor()
        return "Vecway-iOS/\(version) (\(deviceFormFactor))"
    }

    private static func detectDeviceFormFactor() -> String {
        if let simModel = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"],
           simModel.hasPrefix("iPad") {
            return "iPad"
        }
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) {
                String(cString: $0)
            }
        }
        return machine.hasPrefix("iPad") ? "iPad" : "iPhone"
    }
}

/// Abstract HTTP transport protocol for `EndpointManager` (enables deterministic mock tests).
public protocol HTTPTransporting: Sendable {
    func send(
        channel: NativeChannel,
        baseURL: String,
        path: String,
        method: String,
        headers: [String: String]?,
        body: Data?,
        bearerToken: String?,
        expectedCertSha256: String?,
        timeout: TimeInterval
    ) async throws -> TransportResponse

    func pair(
        channel: NativeChannel,
        baseURL: String,
        code: String,
        deviceName: String?,
        expectedCertSha256: String?,
        timeout: TimeInterval
    ) async throws -> PairExchangeResponse

    func invalidateSessions()
}

/// `URLSessionDelegate` implementing strict leaf certificate DER SHA-256 pinning.
/// Used EXCLUSIVELY for `lan_tls` and `ipv6_tls` channels; NEVER used for `tunnel`.
public final class PinningSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let expectedDigest: Data
    private let expectedHex: String
    private let channel: NativeChannel
    private let lock = NSLock()
    private var mismatchesByHost: [String: NativePinMismatch] = [:]
    private var lastMismatch: NativePinMismatch?

    public init(expectedDigest: Data, expectedHex: String, channel: NativeChannel) {
        self.expectedDigest = expectedDigest
        self.expectedHex = expectedHex
        self.channel = channel
        super.init()
    }

    public func consumeMismatch(forHost host: String?) -> NativePinMismatch? {
        lock.lock()
        defer { lock.unlock() }
        if let key = host?.lowercased(), let found = mismatchesByHost.removeValue(forKey: key) {
            if lastMismatch == found { lastMismatch = nil }
            return found
        }
        let fallback = lastMismatch
        lastMismatch = nil
        return fallback
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let serverTrust = challenge.protectionSpace.serverTrust,
              let leafDER = TransportSecurity.leafCertificateDER(from: serverTrust) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        let host = challenge.protectionSpace.host
        do {
            try TransportSecurity.verifyLeafCertificateDER(
                leafDER,
                expectedDigest: expectedDigest,
                expectedHex: expectedHex,
                host: host,
                channel: channel
            )
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } catch let pinError as PinMismatchError {
            lock.lock()
            mismatchesByHost[host.lowercased()] = pinError.mismatch
            lastMismatch = pinError.mismatch
            lock.unlock()
            completionHandler(.cancelAuthenticationChallenge, nil)
        } catch {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// Block automatic redirects to prevent Bearer token exfiltration or HTTPS-to-HTTP downgrade.
    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// Delegate for `tunnel` channel: uses strict system Root CA validation (no custom `serverTrust` handler)
/// while blocking automatic HTTP redirects.
private final class SystemNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// Dual-session HTTPS transport:
/// - `pinnedSession`: leaf DER SHA-256 pinning strictly for `lan_tls` and `ipv6_tls`.
/// - `systemSession`: unmodified Apple system Root CA verification strictly for `tunnel`.
public final class PinnedTransport: HTTPTransporting, @unchecked Sendable {
    private struct PinnedSessionKey: Hashable {
        let channel: NativeChannel
        let pinHex: String
    }

    private struct PinnedSessionEntry {
        let session: URLSession
        let delegate: PinningSessionDelegate
    }

    public let userAgent: String

    private let lock = NSLock()
    private var pinnedSessions: [PinnedSessionKey: PinnedSessionEntry] = [:]
    private let systemDelegate: SystemNoRedirectDelegate
    private let systemSession: URLSession

    public init(userAgent: String = TransportSecurity.defaultUserAgent()) {
        self.userAgent = userAgent
        let sysDelegate = SystemNoRedirectDelegate()
        self.systemDelegate = sysDelegate
        self.systemSession = URLSession(
            configuration: Self.makeEphemeralConfig(),
            delegate: sysDelegate,
            delegateQueue: nil
        )
    }

    deinit {
        invalidateSessions()
        systemSession.invalidateAndCancel()
    }

    public func invalidateSessions() {
        lock.lock()
        let entries = Array(pinnedSessions.values)
        pinnedSessions.removeAll()
        lock.unlock()
        for entry in entries {
            entry.session.invalidateAndCancel()
        }
    }

    public func send(
        channel: NativeChannel,
        baseURL: String,
        path: String,
        method: String,
        headers: [String: String]? = nil,
        body: Data? = nil,
        bearerToken: String?,
        expectedCertSha256: String?,
        timeout: TimeInterval = 30
    ) async throws -> TransportResponse {
        let url = try TransportSecurity.resolveEndpointURL(base: baseURL, path: path)
        let request = makeRequest(
            url: url,
            method: method,
            headers: headers,
            body: body,
            bearerToken: bearerToken,
            timeout: timeout
        )

        let (session, pinningDelegate) = try sessionFor(
            channel: channel,
            expectedCertSha256: expectedCertSha256,
            ephemeral: false
        )
        return try await execute(request: request, session: session, pinningDelegate: pinningDelegate)
    }

    public func pair(
        channel: NativeChannel,
        baseURL: String,
        code: String,
        deviceName: String?,
        expectedCertSha256: String?,
        timeout: TimeInterval = 8
    ) async throws -> PairExchangeResponse {
        let url = try TransportSecurity.resolveEndpointURL(base: baseURL, path: "/pair")

        struct PairRequestBody: Encodable {
            let code: String
            let name: String?
            let returnToken: Bool
        }
        let bodyData = try JSONEncoder().encode(
            PairRequestBody(code: code, name: deviceName, returnToken: true)
        )
        let request = makeRequest(
            url: url,
            method: "POST",
            headers: ["Content-Type": "application/json", "Accept": "application/json"],
            body: bodyData,
            bearerToken: nil,
            timeout: timeout
        )

        let (session, pinningDelegate) = try sessionFor(
            channel: channel,
            expectedCertSha256: expectedCertSha256,
            ephemeral: true
        )
        defer {
            if channel.requiresCertificatePin {
                session.finishTasksAndInvalidate()
            }
        }

        let response = try await execute(
            request: request,
            session: session,
            pinningDelegate: pinningDelegate,
            preserveSetCookie: channel == .tunnel
        )
        if response.status == 204, channel == .tunnel,
           let setCookie = response.headers.first(where: { $0.key.lowercased() == "set-cookie" })?.value,
           let cookieToken = Self.extractOmpwsToken(fromSetCookie: setCookie),
           !cookieToken.isEmpty {
            return PairExchangeResponse(token: cookieToken, device: nil)
        }
        guard response.status == 200 else {
            if (300...399).contains(response.status) {
                let location = response.headers.first { $0.key.lowercased() == "location" }?.value.lowercased() ?? ""
                if location.contains("cloudflareaccess") {
                    throw TransportError.httpError(
                        status: response.status,
                        message: "域名触发了 Cloudflare Zero Trust 登录拦截，请在控制台为配对与 API 放行后重试"
                    )
                }
                throw TransportError.httpError(
                    status: response.status,
                    message: "域名返回了重定向（HTTP \(response.status)），若开启了登录网关请先放行"
                )
            }
            let errMsg = Self.extractServerErrorMessage(from: response.body)
                ?? "配对失败（HTTP \(response.status)）"
            throw TransportError.httpError(status: response.status, message: errMsg)
        }

        guard let decoded = try? JSONDecoder().decode(PairExchangeResponse.self, from: response.body),
              !decoded.token.isEmpty else {
            throw TransportError.invalidResponse
        }
        return decoded
    }

    // MARK: - Helpers

    public func makeRequest(
        url: URL,
        method: String,
        headers: [String: String]?,
        body: Data?,
        bearerToken: String?,
        timeout: TimeInterval
    ) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        request.httpMethod = method.uppercased()
        request.httpBody = body
        request.httpShouldHandleCookies = false

        let sanitized = HeaderSanitizer.sanitize(
            headers: headers,
            bearerToken: bearerToken,
            userAgent: userAgent
        )
        for (key, value) in sanitized {
            request.setValue(value, forHTTPHeaderField: key)
        }
        if request.value(forHTTPHeaderField: "Accept-Encoding") == nil {
            request.setValue("gzip, deflate", forHTTPHeaderField: "Accept-Encoding")
        }
        return request
    }

    private func sessionFor(
        channel: NativeChannel,
        expectedCertSha256: String?,
        ephemeral: Bool
    ) throws -> (URLSession, PinningSessionDelegate?) {
        switch channel {
        case .tunnel:
            // SECURITY: Tunnel MUST ALWAYS use system Root CA verification, NEVER PinningSessionDelegate.
            return (systemSession, nil)
        case .lanTls, .ipv6Tls:
            guard let pinHex = expectedCertSha256, !pinHex.isEmpty else {
                throw TransportError.missingCertificatePin(channel)
            }
            guard let digest = CertificateFingerprint.parse(pinHex) else {
                throw TransportError.invalidCertificatePin
            }

            if ephemeral {
                let delegate = PinningSessionDelegate(
                    expectedDigest: digest,
                    expectedHex: pinHex,
                    channel: channel
                )
                let session = URLSession(
                    configuration: Self.makeEphemeralConfig(),
                    delegate: delegate,
                    delegateQueue: nil
                )
                return (session, delegate)
            }

            let key = PinnedSessionKey(channel: channel, pinHex: pinHex)
            lock.lock()
            if let existing = pinnedSessions[key] {
                lock.unlock()
                return (existing.session, existing.delegate)
            }
            let delegate = PinningSessionDelegate(
                expectedDigest: digest,
                expectedHex: pinHex,
                channel: channel
            )
            let session = URLSession(
                configuration: Self.makeEphemeralConfig(),
                delegate: delegate,
                delegateQueue: nil
            )
            pinnedSessions[key] = PinnedSessionEntry(session: session, delegate: delegate)
            lock.unlock()
            return (session, delegate)
        }
    }

    private func execute(
        request: URLRequest,
        session: URLSession,
        pinningDelegate: PinningSessionDelegate?,
        preserveSetCookie: Bool = false
    ) async throws -> TransportResponse {
        guard let url = request.url else {
            throw TransportError.invalidURL("")
        }
        try TransportSecurity.validateHTTPSURL(url)

        do {
            let (data, rawResponse) = try await session.data(for: request)
            guard let http = rawResponse as? HTTPURLResponse else {
                throw TransportError.invalidResponse
            }
            let hasContentEncoding = http.allHeaderFields.contains { key, _ in
                String(describing: key).lowercased() == "content-encoding"
            }
            let isHead = request.httpMethod?.uppercased() == "HEAD"
            var responseHeaders: [String: String] = [:]
            for (k, v) in http.allHeaderFields {
                let keyStr = String(describing: k)
                let lower = keyStr.lowercased()
                if !preserveSetCookie && lower == "set-cookie" {
                    continue
                }
                if hasContentEncoding && !isHead && (lower == "content-encoding" || lower == "content-length") {
                    continue
                }
                responseHeaders[keyStr] = String(describing: v)
            }
            return TransportResponse(status: http.statusCode, headers: responseHeaders, body: data)
        } catch let error as CancellationError {
            throw error
        } catch {
            if let mismatch = pinningDelegate?.consumeMismatch(forHost: url.host) {
                throw TransportError.pinMismatch(mismatch)
            }
            if let urlError = error as? URLError {
                if urlError.code == .cancelled && Task.isCancelled {
                    throw TransportError.cancelled
                }
                if pinningDelegate == nil {
                    let nsError = urlError as NSError
                    let underlying = (nsError.userInfo[NSUnderlyingErrorKey] as? NSError).map {
                        " / \($0.domain)(\($0.code))"
                    } ?? ""
                    switch urlError.code {
                    case .serverCertificateUntrusted,
                         .serverCertificateHasUnknownRoot,
                         .serverCertificateNotYetValid,
                         .serverCertificateHasBadDate:
                        throw TransportError.unreachable(
                            "HTTPS 证书未受系统根证书信任（URLError \(urlError.code.rawValue)\(underlying)）：\(urlError.localizedDescription)。若这是自签名 DDNS 端口，请填写电脑端证书指纹或改用扫码配对"
                        )
                    case .secureConnectionFailed:
                        throw TransportError.unreachable(
                            "TLS 握手连接失败（URLError \(urlError.code.rawValue)\(underlying)）：\(urlError.localizedDescription)。请确认当前网络/代理可正常访问该域名（可先在手机 Safari 打开该域名测试），或检查 Cloudflare 边缘连接"
                        )
                    default:
                        break
                    }
                }
            }
            throw TransportError.unreachable(error.localizedDescription)
        }
    }

    private static func makeEphemeralConfig() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.waitsForConnectivity = false
        return config
    }

    /// Extracts `ompws_token=<value>` from a `Set-Cookie` response header returned by legacy HTTPS `/pair`.
    public static func extractOmpwsToken(fromSetCookie header: String) -> String? {
        for segment in header.split(separator: ";") {
            let trimmed = segment.trimmingCharacters(in: .whitespacesAndNewlines)
            if let range = trimmed.range(of: "ompws_token=", options: [.anchored]) {
                let value = String(trimmed[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty {
                    return value
                }
            }
        }
        return nil
    }

    public static func extractServerErrorMessage(from body: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            return nil
        }
        if let msg = obj["error"] as? String, !msg.isEmpty {
            return msg
        }
        if let nested = obj["error"] as? [String: Any],
           let msg = nested["message"] as? String, !msg.isEmpty {
            return msg
        }
        if let msg = obj["message"] as? String, !msg.isEmpty {
            return msg
        }
        return nil
    }
}
