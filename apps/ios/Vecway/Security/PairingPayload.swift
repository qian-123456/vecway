import Foundation

/// Transport channels supported by the native iOS shell.
public enum NativeChannel: String, Codable, Equatable, Hashable, Sendable {
    case lanTls = "lan_tls"
    case ipv6Tls = "ipv6_tls"
    case tunnel = "tunnel"

    public var displayName: String {
        switch self {
        case .lanTls: return "局域网 TLS"
        case .ipv6Tls: return "IPv6 TLS"
        case .tunnel: return "Cloudflare / 公网域名"
        }
    }

    public var requiresCertificatePin: Bool {
        switch self {
        case .lanTls, .ipv6Tls: return true
        case .tunnel: return false
        }
    }
}

/// Preferred channel hint embedded in desktop pairing QR payloads.
public enum PairingTarget: String, Codable, Equatable, Sendable {
    case lan = "lan"
    case ipv6 = "ipv6"
    case tunnel = "tunnel"

    public var channel: NativeChannel {
        switch self {
        case .lan: return .lanTls
        case .ipv6: return .ipv6Tls
        case .tunnel: return .tunnel
        }
    }
}

/// Candidate HTTPS endpoints persisted for a paired desktop.
public struct EndpointCandidates: Codable, Equatable, Sendable {
    public var lanTls: String?
    public var ipv6: String?
    public var tunnel: String?

    public init(lanTls: String? = nil, ipv6: String? = nil, tunnel: String? = nil) {
        self.lanTls = lanTls
        self.ipv6 = ipv6
        self.tunnel = tunnel
    }

    public var isEmpty: Bool {
        lanTls == nil && ipv6 == nil && tunnel == nil
    }

    public func url(for channel: NativeChannel) -> String? {
        switch channel {
        case .lanTls: return lanTls
        case .ipv6Tls: return ipv6
        case .tunnel: return tunnel
        }
    }
}

/// SHA-256 certificate fingerprint formatting & strict parsing.
/// Matches Rust `src-tauri/src/mobile/tls.rs`: 32 bytes uppercase colon-separated hex (`AA:BB:...:FF`, 95 chars).
public enum CertificateFingerprint {
    public static let expectedCharCount = 95
    public static let expectedByteCount = 32

    public static func parse(_ value: String) -> Data? {
        let bytes = Array(value.utf8)
        guard bytes.count == expectedCharCount else { return nil }

        var digest = Data()
        digest.reserveCapacity(expectedByteCount)

        for idx in 0..<expectedByteCount {
            let offset = idx * 3
            guard let hi = uppercaseHexNibble(bytes[offset]),
                  let lo = uppercaseHexNibble(bytes[offset + 1]) else {
                return nil
            }
            if idx < expectedByteCount - 1 {
                guard bytes[offset + 2] == UInt8(ascii: ":") else { return nil }
            }
            digest.append((hi << 4) | lo)
        }
        return digest
    }

    public static func format(_ digest: Data) -> String {
        digest.map { String(format: "%02X", $0) }.joined(separator: ":")
    }

    /// Abbreviated human-readable summary (`AA:BB:CC:DD … WW:XX:YY:ZZ`).
    public static func abbreviated(_ fingerprint: String) -> String {
        guard fingerprint.count >= 23 else { return fingerprint }
        return "\(fingerprint.prefix(11)) … \(fingerprint.suffix(11))"
    }

    private static func uppercaseHexNibble(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"):
            return byte - UInt8(ascii: "0")
        case UInt8(ascii: "A")...UInt8(ascii: "F"):
            return byte - UInt8(ascii: "A") + 10
        default:
            return nil
        }
    }
}

/// Parses a strict 95-char colon-separated uppercase SHA-256 fingerprint into 32 raw bytes.
public func parseSha256Fingerprint(_ value: String) -> Data? {
    CertificateFingerprint.parse(value)
}

/// Formats raw SHA-256 bytes into uppercase colon-separated hex (`AA:BB:...:FF`).
public func formatSha256Fingerprint(_ digest: Data) -> String {
    CertificateFingerprint.format(digest)
}

public enum PairingPayloadError: Error, LocalizedError, Equatable, Sendable {
    case invalidURL
    case missingAppPayload
    case invalidBase64Payload
    case invalidJSONPayload
    case unsupportedVersion(Int)
    case invalidCode
    case insecureEndpoint(field: String, value: String)
    case invalidEndpointURL(field: String, value: String)
    case invalidFingerprint
    case missingFingerprintForPinnedEndpoint
    case noEndpoints

    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "配对二维码或链接格式无效"
        case .missingAppPayload:
            return "电脑端当前版本未开启局域网加密（二维码仅含明文 HTTP）。请启动新版电脑端后再扫，或点下方「用域名或链接配对」"
        case .invalidBase64Payload, .invalidJSONPayload:
            return "配对载荷解析失败，请重新生成二维码"
        case .unsupportedVersion(let version):
            return "不支持的配对协议版本（v\(version)），请更新 App"
        case .invalidCode:
            return "配对码无效或格式错误"
        case .insecureEndpoint(let field, _):
            return "安全拦截：通道 \(field) 必须使用 HTTPS 加密连接，禁止明文 HTTP"
        case .invalidEndpointURL(let field, _):
            return "通道 \(field) 的地址格式无效"
        case .invalidFingerprint:
            return "证书 SHA-256 指纹格式无效"
        case .missingFingerprintForPinnedEndpoint:
            return "局域网或 IPv6 TLS 连接必须携带证书 SHA-256 指纹"
        case .noEndpoints:
            return "配对信息中不包含可用的 HTTPS 连接地址"
        }
    }
}

/// Validated pairing payload parsed from either a dual-use QR URL (`#app=...`)
/// or an app-direct deep link (`vecway://pair?...`).
public struct PairingPayload: Equatable, Sendable {
    public let version: Int
    public let code: String
    public let preferredTarget: PairingTarget?
    public let endpoints: EndpointCandidates
    public let certSha256: String?
    public let certSha256Digest: Data?

    private struct FragmentPayloadJSON: Decodable {
        let v: Int
        let t: String?
        let lt: String?
        let fp: String?
        let v6: String?
        let tn: String?
    }

    public init(
        version: Int,
        code: String,
        preferredTarget: PairingTarget?,
        endpoints: EndpointCandidates,
        certSha256: String?,
        certSha256Digest: Data?
    ) {
        self.version = version
        self.code = code
        self.preferredTarget = preferredTarget
        self.endpoints = endpoints
        self.certSha256 = certSha256
        self.certSha256Digest = certSha256Digest
    }

    /// Parses either:
    /// 1. Dual-use QR URL: `<base>/pair?code=<code>#app=<base64url(json)>`
    ///    (The outer plaintext `http://` prefix is completely ignored.)
    /// 2. App-direct URL: `vecway://pair?v=1&code=<code>&t=...&lt=...&fp=...&v6=...&tn=...`
    public static func parse(_ rawInput: String) throws -> PairingPayload {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let components = URLComponents(string: trimmed) else {
            throw PairingPayloadError.invalidURL
        }

        let scheme = components.scheme?.lowercased() ?? ""
        if scheme == "vecway" {
            return try parseDirectAppURL(components)
        }
        if scheme == "http" || scheme == "https" {
            return try parseDualUseURL(components)
        }
        throw PairingPayloadError.invalidURL
    }

    /// Validates an endpoint base URL strictly requires `https://` and a valid host.
    public static func validateHttpsEndpoint(_ raw: String, field: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var components = URLComponents(string: trimmed) else {
            throw PairingPayloadError.invalidEndpointURL(field: field, value: raw)
        }
        guard let scheme = components.scheme?.lowercased() else {
            throw PairingPayloadError.invalidEndpointURL(field: field, value: raw)
        }
        guard scheme == "https" else {
            throw PairingPayloadError.insecureEndpoint(field: field, value: raw)
        }
        guard let host = components.host, !host.isEmpty else {
            throw PairingPayloadError.invalidEndpointURL(field: field, value: raw)
        }
        guard components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil else {
            throw PairingPayloadError.invalidEndpointURL(field: field, value: raw)
        }
        if components.path == "/" {
            components.path = ""
        } else if !components.path.isEmpty {
            throw PairingPayloadError.invalidEndpointURL(field: field, value: raw)
        }
        components.scheme = "https"
        guard let normalized = components.string else {
            throw PairingPayloadError.invalidEndpointURL(field: field, value: raw)
        }
        return normalized
    }

    /// Normalizes user-entered endpoint text (`omp.example.com` -> `https://omp.example.com`)
    /// while strictly rejecting explicit `http://` or any non-HTTPS scheme.
    public static func normalizeHttpsEndpointInput(_ raw: String, field: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw PairingPayloadError.invalidEndpointURL(field: field, value: raw)
        }
        if trimmed.contains("://") {
            return try validateHttpsEndpoint(trimmed, field: field)
        }
        return try validateHttpsEndpoint("https://\(trimmed)", field: field)
    }

    /// Extracts an embedded `?code=...` pairing code from a pasted URL if present.
    public static func extractCodeFromInput(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let components = URLComponents(string: candidate) else { return nil }
        return queryDictionary(from: components.queryItems)["code"]
    }

    /// Builds a validated `PairingPayload` from manual domain/URL + pairing code input
    /// (supporting Cloudflare Tunnel / reverse-proxy CA domains without `#app=`, as well as
    /// optional self-signed certificate SHA-256 pinning for direct DDNS IPv6 ports).
    public static func fromDomainInput(
        domainOrURL: String,
        code rawCode: String?,
        certSha256 rawFingerprint: String? = nil
    ) throws -> PairingPayload {
        let trimmedInput = domainOrURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInput.isEmpty else {
            throw PairingPayloadError.invalidEndpointURL(field: "domain", value: domainOrURL)
        }

        if trimmedInput.lowercased().hasPrefix("vecway://") {
            return try parse(trimmedInput)
        }

        let normalizedInput = trimmedInput.contains("://") ? trimmedInput : "https://\(trimmedInput)"
        guard var components = URLComponents(string: normalizedInput) else {
            throw PairingPayloadError.invalidEndpointURL(field: "domain", value: domainOrURL)
        }
        guard let scheme = components.scheme?.lowercased(), scheme == "https" else {
            throw PairingPayloadError.insecureEndpoint(field: "domain", value: domainOrURL)
        }
        guard let host = components.host, !host.isEmpty else {
            throw PairingPayloadError.invalidEndpointURL(field: "domain", value: domainOrURL)
        }
        guard components.user == nil, components.password == nil else {
            throw PairingPayloadError.invalidEndpointURL(field: "domain", value: domainOrURL)
        }

        let queryMap = queryDictionary(from: components.queryItems)
        let manualCode = rawCode?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedCode = (manualCode?.isEmpty == false) ? manualCode : queryMap["code"]
        let code = try validateCode(resolvedCode)

        // If a full dual-use URL with `#app=` was pasted and no manual overrides exist, parse it directly.
        if let fragment = components.fragment,
           extractFragmentParameter(named: "app", from: fragment) != nil,
           (manualCode == nil || manualCode?.isEmpty == true),
           (rawFingerprint?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) {
            return try parse(normalizedInput)
        }

        components.scheme = "https"
        components.path = ""
        components.queryItems = nil
        components.fragment = nil
        guard let origin = components.string else {
            throw PairingPayloadError.invalidEndpointURL(field: "domain", value: domainOrURL)
        }

        let trimmedFP = rawFingerprint?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedFP.isEmpty {
            guard let digest = CertificateFingerprint.parse(trimmedFP) else {
                throw PairingPayloadError.invalidFingerprint
            }
            return PairingPayload(
                version: 1,
                code: code,
                preferredTarget: .ipv6,
                endpoints: EndpointCandidates(ipv6: origin),
                certSha256: trimmedFP,
                certSha256Digest: digest
            )
        }

        return PairingPayload(
            version: 1,
            code: code,
            preferredTarget: .tunnel,
            endpoints: EndpointCandidates(tunnel: origin),
            certSha256: nil,
            certSha256Digest: nil
        )
    }

    /// Returns candidate channels in the exact order pairing should attempt them.
    public func orderedPairingAttempts() -> [(channel: NativeChannel, url: String)] {
        var order: [NativeChannel] = [.lanTls, .ipv6Tls, .tunnel]
        if let preferred = preferredTarget?.channel {
            order.removeAll { $0 == preferred }
            order.insert(preferred, at: 0)
        }
        return order.compactMap { channel in
            guard let url = endpoints.url(for: channel) else { return nil }
            return (channel, url)
        }
    }

    // MARK: - Private Parsers

    private static func parseDualUseURL(_ components: URLComponents) throws -> PairingPayload {
        // SECURITY: Explicitly ignore `components.scheme`, `components.host`, and `components.port`
        // whenever `#app=` is present. If `#app=` is absent on an `https://` URL, fall back to
        // system-CA HTTPS domain pairing for that validated origin (never for plaintext `http://`).
        let queryMap = queryDictionary(from: components.queryItems)
        let code = try validateCode(queryMap["code"])

        if let fragment = components.fragment,
           !fragment.isEmpty,
           let encodedAppPayload = extractFragmentParameter(named: "app", from: fragment),
           !encodedAppPayload.isEmpty {
            guard let jsonData = decodeBase64URL(encodedAppPayload) else {
                throw PairingPayloadError.invalidBase64Payload
            }
            let decoded: FragmentPayloadJSON
            do {
                decoded = try JSONDecoder().decode(FragmentPayloadJSON.self, from: jsonData)
            } catch {
                throw PairingPayloadError.invalidJSONPayload
            }

            return try buildValidatedPayload(
                version: decoded.v,
                code: code,
                rawTarget: decoded.t,
                rawLanTls: decoded.lt,
                rawIpv6: decoded.v6,
                rawTunnel: decoded.tn,
                rawFingerprint: decoded.fp
            )
        }

        if components.scheme?.lowercased() == "https",
           let host = components.host,
           !host.isEmpty,
           components.user == nil,
           components.password == nil {
            var originComps = URLComponents()
            originComps.scheme = "https"
            originComps.host = host
            originComps.port = components.port
            if let origin = originComps.string {
                return PairingPayload(
                    version: 1,
                    code: code,
                    preferredTarget: .tunnel,
                    endpoints: EndpointCandidates(tunnel: origin),
                    certSha256: nil,
                    certSha256Digest: nil
                )
            }
        }

        throw PairingPayloadError.missingAppPayload
    }

    private static func parseDirectAppURL(_ components: URLComponents) throws -> PairingPayload {
        guard components.host?.lowercased() == "pair" else {
            throw PairingPayloadError.invalidURL
        }
        let queryMap = queryDictionary(from: components.queryItems)
        guard let versionStr = queryMap["v"], let version = Int(versionStr) else {
            throw PairingPayloadError.unsupportedVersion(0)
        }
        let code = try validateCode(queryMap["code"])

        return try buildValidatedPayload(
            version: version,
            code: code,
            rawTarget: queryMap["t"],
            rawLanTls: queryMap["lt"],
            rawIpv6: queryMap["v6"],
            rawTunnel: queryMap["tn"],
            rawFingerprint: queryMap["fp"]
        )
    }

    private static func buildValidatedPayload(
        version: Int,
        code: String,
        rawTarget: String?,
        rawLanTls: String?,
        rawIpv6: String?,
        rawTunnel: String?,
        rawFingerprint: String?
    ) throws -> PairingPayload {
        guard version == 1 else {
            throw PairingPayloadError.unsupportedVersion(version)
        }

        let lanTls = try validateOptionalEndpoint(rawLanTls, field: "lt")
        let ipv6 = try validateOptionalEndpoint(rawIpv6, field: "v6")
        let tunnel = try validateOptionalEndpoint(rawTunnel, field: "tn")

        let endpoints = EndpointCandidates(lanTls: lanTls, ipv6: ipv6, tunnel: tunnel)
        guard !endpoints.isEmpty else {
            throw PairingPayloadError.noEndpoints
        }

        let trimmedFP = rawFingerprint?.trimmingCharacters(in: .whitespacesAndNewlines)
        let certSha256: String?
        let certDigest: Data?
        if let fp = trimmedFP, !fp.isEmpty {
            guard let digest = CertificateFingerprint.parse(fp) else {
                throw PairingPayloadError.invalidFingerprint
            }
            certSha256 = fp
            certDigest = digest
        } else {
            certSha256 = nil
            certDigest = nil
        }

        if (lanTls != nil || ipv6 != nil) && certDigest == nil {
            throw PairingPayloadError.missingFingerprintForPinnedEndpoint
        }

        let target = rawTarget.flatMap { PairingTarget(rawValue: $0.trimmingCharacters(in: .whitespacesAndNewlines)) }

        return PairingPayload(
            version: version,
            code: code,
            preferredTarget: target,
            endpoints: endpoints,
            certSha256: certSha256,
            certSha256Digest: certDigest
        )
    }

    private static func validateOptionalEndpoint(_ raw: String?, field: String) throws -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return try validateHttpsEndpoint(trimmed, field: field)
    }

    private static func validateCode(_ raw: String?) throws -> String {
        guard let code = raw, !code.isEmpty else {
            throw PairingPayloadError.invalidCode
        }
        let valid = code.utf8.allSatisfy { b in
            (b >= UInt8(ascii: "a") && b <= UInt8(ascii: "z"))
                || (b >= UInt8(ascii: "A") && b <= UInt8(ascii: "Z"))
                || (b >= UInt8(ascii: "0") && b <= UInt8(ascii: "9"))
                || b == UInt8(ascii: "-")
                || b == UInt8(ascii: "_")
        }
        guard valid else {
            throw PairingPayloadError.invalidCode
        }
        return code
    }

    private static func queryDictionary(from items: [URLQueryItem]?) -> [String: String] {
        var result: [String: String] = [:]
        for item in items ?? [] {
            if let value = item.value {
                result[item.name] = value
            }
        }
        return result
    }

    private static func extractFragmentParameter(named name: String, from fragment: String) -> String? {
        let prefix = "\(name)="
        for part in fragment.split(separator: "&", omittingEmptySubsequences: true) {
            if part.hasPrefix(prefix) {
                return String(part.dropFirst(prefix.count))
            }
        }
        return nil
    }

    private static func decodeBase64URL(_ input: String) -> Data? {
        var base64 = input
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder == 1 {
            return nil
        }
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: base64)
    }
}
