import Foundation
#if canImport(Network)
import Network
#endif

/// Connection status snapshot matching the TypeScript `NativeEndpointStatus` bridge contract.
public struct NativeEndpointStatus: Codable, Equatable, Sendable {
    public let paired: Bool
    public let activeChannel: NativeChannel?
    public let activeUrl: String?
    public let certSha256: String?
    public let candidates: EndpointCandidates
    public let pinMismatch: NativePinMismatch?

    public init(
        paired: Bool,
        activeChannel: NativeChannel? = nil,
        activeUrl: String? = nil,
        certSha256: String? = nil,
        candidates: EndpointCandidates = EndpointCandidates(),
        pinMismatch: NativePinMismatch? = nil
    ) {
        self.paired = paired
        self.activeChannel = activeChannel
        self.activeUrl = activeUrl
        self.certSha256 = certSha256
        self.candidates = candidates
        self.pinMismatch = pinMismatch
    }

    enum CodingKeys: String, CodingKey {
        case paired
        case activeChannel
        case activeUrl
        case certSha256
        case candidates
        case pinMismatch
    }

    /// Explicitly encodes `null` for nullable fields so JS receives strict `null` rather than `undefined`.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(paired, forKey: .paired)
        if let activeChannel {
            try container.encode(activeChannel, forKey: .activeChannel)
        } else {
            try container.encodeNil(forKey: .activeChannel)
        }
        if let activeUrl {
            try container.encode(activeUrl, forKey: .activeUrl)
        } else {
            try container.encodeNil(forKey: .activeUrl)
        }
        if let certSha256 {
            try container.encode(certSha256, forKey: .certSha256)
        } else {
            try container.encodeNil(forKey: .certSha256)
        }
        try container.encode(candidates, forKey: .candidates)
        if let pinMismatch {
            try container.encode(pinMismatch, forKey: .pinMismatch)
        } else {
            try container.encodeNil(forKey: .pinMismatch)
        }
    }
}

/// Partial update patch for `EndpointManager.updateEndpoints(_:)`.
/// `nil` = leave untouched; `.some(nil)` or `.some("")` = clear; `.some("https://...")` = update.
public struct EndpointUpdatePatch: Equatable, Sendable {
    public var lanTls: String??
    public var ipv6: String??
    public var tunnel: String??

    public init(lanTls: String?? = nil, ipv6: String?? = nil, tunnel: String?? = nil) {
        self.lanTls = lanTls
        self.ipv6 = ipv6
        self.tunnel = tunnel
    }
}

/// Manages channel selection (`lan_tls` -> `ipv6_tls` || `tunnel`), pairing, candidate syncing,
/// network transition re-probing, and strict certificate pin-mismatch hard blocking.
public final class EndpointManager: @unchecked Sendable {
    private enum ProbeOutcome: Sendable {
        case reachable(channel: NativeChannel, url: String)
        case pinMismatch(NativePinMismatch)
        case unauthorized
        case unreachable
    }

    private struct SettingsSummaryResponse: Decodable {
        struct MobileSection: Decodable {
            let lanTlsUrl: String?
            let ipv6Url: String?
            let tunnelUrl: String?
            // SECURITY: `certSha256` from settings summary is deliberately NOT decoded for pinning.
            // Client MUST NEVER silently mutate `pinnedCertSha256` from a remote API response.
        }
        let mobile: MobileSection?
    }

    private let store: CredentialStore
    private let transport: HTTPTransporting
    private let lanProbeTimeout: TimeInterval
    private let remoteProbeTimeout: TimeInterval

    private let lock = NSLock()
    private var cachedCredentials: StoredCredentials?
    private var activeChannel: NativeChannel?
    private var activeUrl: String?
    private var pinMismatch: NativePinMismatch?
    private var isUnauthorized = false
    private var listeners: [UUID: @Sendable (NativeEndpointStatus) -> Void] = [:]

    public var onWillUnpair: (@Sendable () -> Void)?
    public var onUnauthorized: (@Sendable () -> Void)?
    public var onPinMismatchDetected: (@Sendable (NativePinMismatch) -> Void)?

    #if canImport(Network)
    private var pathMonitor: NWPathMonitor?
    private let pathQueue = DispatchQueue(label: "dev.vecway.mobile.network-path")
    private var lastPathSignature: String?
    #endif

    public init(
        store: CredentialStore,
        transport: HTTPTransporting = PinnedTransport(),
        lanProbeTimeout: TimeInterval = 1.5,
        remoteProbeTimeout: TimeInterval = 10.0
    ) {
        self.store = store
        self.transport = transport
        self.lanProbeTimeout = lanProbeTimeout
        self.remoteProbeTimeout = remoteProbeTimeout
        self.cachedCredentials = try? store.load()
    }

    deinit {
        stopNetworkMonitoring()
    }

    // MARK: - Observers & Snapshots

    @discardableResult
    public func addStatusListener(_ listener: @escaping @Sendable (NativeEndpointStatus) -> Void) -> UUID {
        let id = UUID()
        lock.lock()
        listeners[id] = listener
        lock.unlock()
        return id
    }

    public func removeStatusListener(_ id: UUID) {
        lock.lock()
        listeners.removeValue(forKey: id)
        lock.unlock()
    }

    public func currentCredentials() -> StoredCredentials? {
        lock.lock()
        defer { lock.unlock() }
        if cachedCredentials == nil {
            cachedCredentials = try? store.load()
        }
        return cachedCredentials
    }

    public func currentStatus() -> NativeEndpointStatus {
        lock.lock()
        defer { lock.unlock() }
        return buildStatusLocked()
    }

    public func activeConnection() -> (channel: NativeChannel, url: String, credentials: StoredCredentials)? {
        lock.lock()
        defer { lock.unlock() }
        guard pinMismatch == nil,
              let creds = cachedCredentials,
              let channel = activeChannel,
              let url = activeUrl else {
            return nil
        }
        return (channel, url, creds)
    }

    // MARK: - Pairing & Unpairing

    public func pair(payload: PairingPayload, deviceName: String? = nil) async throws -> NativeEndpointStatus {
        let attempts = payload.orderedPairingAttempts()
        guard !attempts.isEmpty else {
            throw PairingPayloadError.noEndpoints
        }

        var lastError: Error = TransportError.unreachable("无法连接到电脑，请检查网络后重试")
        var succeeded: (channel: NativeChannel, url: String, response: PairExchangeResponse)?

        for (idx, attempt) in attempts.enumerated() {
            let hasMoreCandidates = idx < attempts.count - 1
            let timeout: TimeInterval = (attempt.channel == .lanTls && hasMoreCandidates) ? 2.5 : 12.0
            do {
                let response = try await transport.pair(
                    channel: attempt.channel,
                    baseURL: attempt.url,
                    code: payload.code,
                    deviceName: deviceName,
                    expectedCertSha256: payload.certSha256,
                    timeout: timeout
                )
                succeeded = (attempt.channel, attempt.url, response)
                break
            } catch let error as TransportError {
                switch error {
                case .pinMismatch(let mismatch):
                    // SECURITY: Hard-stop on pin mismatch during pairing; NEVER fall back to another channel.
                    recordPinMismatch(mismatch)
                    throw error
                case .httpError(let status, _) where status == 400 || status == 401 || status == 403:
                    // Code rejected/expired or plaintext blocked — do not retry on other channels.
                    throw error
                case .plaintextForbidden, .missingCertificatePin, .invalidCertificatePin:
                    throw error
                default:
                    lastError = error
                }
            } catch {
                lastError = error
            }
        }

        guard let matched = succeeded else {
            throw lastError
        }

        let newCredentials = StoredCredentials(
            deviceToken: matched.response.token,
            pinnedCertSha256: payload.certSha256,
            endpoints: payload.endpoints,
            preferredTarget: payload.preferredTarget?.rawValue
        )
        try store.save(newCredentials)
        transport.invalidateSessions()

        let status: NativeEndpointStatus = lock.withLock {
            cachedCredentials = newCredentials
            activeChannel = matched.channel
            activeUrl = matched.url
            pinMismatch = nil
            isUnauthorized = false
            return buildStatusLocked()
        }

        notifyListeners(status)

        // Best-effort refresh of latest endpoint candidates after trusted pairing (NEVER touches certSha256).
        await syncCandidatesFromSettings(
            channel: matched.channel,
            baseURL: matched.url,
            credentials: newCredentials
        )
        return currentStatus()
    }

    public func unpair() async throws {
        onWillUnpair?()
        try store.clearAll()
        transport.invalidateSessions()

        let status: NativeEndpointStatus = lock.withLock {
            cachedCredentials = nil
            activeChannel = nil
            activeUrl = nil
            pinMismatch = nil
            isUnauthorized = false
            return buildStatusLocked()
        }

        notifyListeners(status)
    }

    // MARK: - Endpoint Updates

    public func updateEndpoints(_ patch: EndpointUpdatePatch) async throws -> NativeEndpointStatus {
        guard var creds = currentCredentials() else {
            throw TransportError.unpaired
        }

        var updated = creds.endpoints

        if let lanPatch = patch.lanTls {
            updated.lanTls = try validatePatchValue(lanPatch, field: "lanTls")
        }
        if let ipv6Patch = patch.ipv6 {
            updated.ipv6 = try validatePatchValue(ipv6Patch, field: "ipv6")
        }
        if let tunnelPatch = patch.tunnel {
            updated.tunnel = try validatePatchValue(tunnelPatch, field: "tunnel")
        }

        guard !updated.isEmpty else {
            throw PairingPayloadError.noEndpoints
        }
        if (updated.lanTls != nil || updated.ipv6 != nil) && creds.pinnedCertSha256 == nil {
            throw TransportError.missingCertificatePin(updated.lanTls != nil ? .lanTls : .ipv6Tls)
        }

        creds.endpoints = updated
        try store.save(creds)

        lock.withLock {
            cachedCredentials = creds
        }

        return await reprobeConnection()
    }

    // MARK: - Channel Probing & Candidate Sync

    public func reprobeConnection() async -> NativeEndpointStatus {
        guard let creds = currentCredentials() else {
            let status: NativeEndpointStatus = lock.withLock {
                activeChannel = nil
                activeUrl = nil
                pinMismatch = nil
                return buildStatusLocked()
            }
            notifyListeners(status)
            return status
        }

        // SECURITY: Once a certificate pin mismatch is detected, stay hard-blocked until
        // the user explicitly re-pairs or unpairs. Never silently clear or fall back.
        if let blockedStatus: NativeEndpointStatus = lock.withLock({
            guard pinMismatch != nil else { return nil }
            activeChannel = nil
            activeUrl = nil
            return buildStatusLocked()
        }) {
            notifyListeners(blockedStatus)
            return blockedStatus
        }

        // Step 1: Fast-probe LAN TLS first (default 1.5s timeout).
        if let lanUrl = creds.endpoints.lanTls {
            let lanOutcome = await probeSingle(
                channel: .lanTls,
                url: lanUrl,
                credentials: creds,
                timeout: lanProbeTimeout
            )
            switch lanOutcome {
            case .reachable(let ch, let url):
                return await finalizeConnectedChannel(channel: ch, url: url, credentials: creds)
            case .pinMismatch(let mismatch):
                recordPinMismatch(mismatch)
                return currentStatus()
            case .unauthorized:
                markUnauthorized()
                return currentStatus()
            case .unreachable:
                break
            }
        }

        // Step 2: Parallel-probe IPv6 TLS and Cloudflare Tunnel (default 5s timeout).
        var remoteTargets: [(NativeChannel, String)] = []
        if let ipv6Url = creds.endpoints.ipv6 {
            remoteTargets.append((.ipv6Tls, ipv6Url))
        }
        if let tunnelUrl = creds.endpoints.tunnel {
            remoteTargets.append((.tunnel, tunnelUrl))
        }

        if !remoteTargets.isEmpty {
            let outcomes = await withTaskGroup(of: (NativeChannel, ProbeOutcome).self) { group in
                for (channel, url) in remoteTargets {
                    group.addTask {
                        let outcome = await self.probeSingle(
                            channel: channel,
                            url: url,
                            credentials: creds,
                            timeout: self.remoteProbeTimeout
                        )
                        return (channel, outcome)
                    }
                }
                var collected: [NativeChannel: ProbeOutcome] = [:]
                for await (ch, outcome) in group {
                    collected[ch] = outcome
                }
                return collected
            }

            // SECURITY: Pin mismatch on IPv6 TLS MUST hard-block immediately even if Tunnel succeeded.
            for (_, outcome) in outcomes {
                if case .pinMismatch(let mismatch) = outcome {
                    recordPinMismatch(mismatch)
                    return currentStatus()
                }
            }

            // Priority: ipv6_tls > tunnel.
            if case .reachable(let ch, let url) = outcomes[.ipv6Tls] {
                return await finalizeConnectedChannel(channel: ch, url: url, credentials: creds)
            }
            if case .reachable(let ch, let url) = outcomes[.tunnel] {
                return await finalizeConnectedChannel(channel: ch, url: url, credentials: creds)
            }
            for (_, outcome) in outcomes {
                if case .unauthorized = outcome {
                    markUnauthorized()
                    return currentStatus()
                }
            }
        }

        let offlineStatus: NativeEndpointStatus = lock.withLock {
            activeChannel = nil
            activeUrl = nil
            return buildStatusLocked()
        }
        notifyListeners(offlineStatus)
        return offlineStatus
    }

    // MARK: - Authenticated Requests

    public func performRequest(
        method: String,
        path: String,
        headers: [String: String]? = nil,
        body: Data? = nil,
        timeoutMs: Int? = nil
    ) async throws -> TransportResponse {
        if let mismatch = lock.withLock({ pinMismatch }) {
            throw TransportError.pinMismatch(mismatch)
        }

        guard currentCredentials() != nil else {
            throw TransportError.unpaired
        }

        var conn = activeConnection()
        if conn == nil {
            _ = await reprobeConnection()
            if let mismatch = lock.withLock({ pinMismatch }) {
                throw TransportError.pinMismatch(mismatch)
            }
            conn = activeConnection()
        }

        guard let active = conn else {
            throw TransportError.unreachable("无法连接到电脑上的 Vecway 服务")
        }

        let timeout = TimeInterval(max(timeoutMs ?? 30_000, 1_000)) / 1000.0
        do {
            let response = try await transport.send(
                channel: active.channel,
                baseURL: active.url,
                path: path,
                method: method,
                headers: headers,
                body: body,
                bearerToken: active.credentials.deviceToken,
                expectedCertSha256: active.credentials.pinnedCertSha256,
                timeout: timeout
            )
            if response.status == 401 {
                markUnauthorized()
            }
            return response
        } catch let error as TransportError {
            if case .pinMismatch(let mismatch) = error {
                recordPinMismatch(mismatch)
            }
            throw error
        }
    }

    // MARK: - Security & Auth Signals

    public func recordPinMismatch(_ mismatch: NativePinMismatch) {
        let status: NativeEndpointStatus
        lock.lock()
        pinMismatch = mismatch
        activeChannel = nil
        activeUrl = nil
        status = buildStatusLocked()
        lock.unlock()

        onPinMismatchDetected?(mismatch)
        notifyListeners(status)
    }

    public func markUnauthorized() {
        let status: NativeEndpointStatus
        lock.lock()
        isUnauthorized = true
        status = buildStatusLocked()
        lock.unlock()

        onUnauthorized?()
        notifyListeners(status)
    }

    // MARK: - Network Path Monitoring

    public func startNetworkMonitoring() {
        #if canImport(Network)
        lock.lock()
        guard pathMonitor == nil else {
            lock.unlock()
            return
        }
        let monitor = NWPathMonitor()
        pathMonitor = monitor
        lock.unlock()

        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let signature = Self.pathSignature(path)
            self.lock.lock()
            let previous = self.lastPathSignature
            self.lastPathSignature = signature
            let shouldProbe = previous != nil
                && previous != signature
                && path.status == .satisfied
                && self.cachedCredentials != nil
                && self.pinMismatch == nil
            self.lock.unlock()

            if shouldProbe {
                Task { [weak self] in
                    _ = await self?.reprobeConnection()
                }
            }
        }
        monitor.start(queue: pathQueue)
        #endif
    }

    public func stopNetworkMonitoring() {
        #if canImport(Network)
        lock.lock()
        let monitor = pathMonitor
        pathMonitor = nil
        lastPathSignature = nil
        lock.unlock()
        monitor?.cancel()
        #endif
    }

    // MARK: - Private Helpers

    private func probeSingle(
        channel: NativeChannel,
        url: String,
        credentials: StoredCredentials,
        timeout: TimeInterval
    ) async -> ProbeOutcome {
        do {
            let response = try await transport.send(
                channel: channel,
                baseURL: url,
                path: "/api/device",
                method: "GET",
                headers: ["Accept": "application/json"],
                body: nil,
                bearerToken: credentials.deviceToken,
                expectedCertSha256: credentials.pinnedCertSha256,
                timeout: timeout
            )
            if response.status == 401 {
                return .unauthorized
            }
            if (200...299).contains(response.status) {
                return .reachable(channel: channel, url: url)
            }
            return .unreachable
        } catch let error as TransportError {
            if case .pinMismatch(let mismatch) = error {
                return .pinMismatch(mismatch)
            }
            return .unreachable
        } catch {
            return .unreachable
        }
    }

    private func finalizeConnectedChannel(
        channel: NativeChannel,
        url: String,
        credentials: StoredCredentials
    ) async -> NativeEndpointStatus {
        let status: NativeEndpointStatus = lock.withLock {
            activeChannel = channel
            activeUrl = url
            isUnauthorized = false
            return buildStatusLocked()
        }
        notifyListeners(status)

        await syncCandidatesFromSettings(channel: channel, baseURL: url, credentials: credentials)
        return currentStatus()
    }

    private func syncCandidatesFromSettings(
        channel: NativeChannel,
        baseURL: String,
        credentials: StoredCredentials
    ) async {
        guard let response = try? await transport.send(
            channel: channel,
            baseURL: baseURL,
            path: "/api/left/settings",
            method: "GET",
            headers: ["Accept": "application/json"],
            body: nil,
            bearerToken: credentials.deviceToken,
            expectedCertSha256: credentials.pinnedCertSha256,
            timeout: remoteProbeTimeout
        ),
            (200...299).contains(response.status),
            let decoded = try? JSONDecoder().decode(SettingsSummaryResponse.self, from: response.body),
            let mobile = decoded.mobile else {
            return
        }

        let updateResult: (StoredCredentials, NativeEndpointStatus)? = lock.withLock {
            guard var latest = cachedCredentials, pinMismatch == nil else {
                return nil
            }
            var updatedEndpoints = latest.endpoints

            // SECURITY: Only accept validated `https://` URLs, and NEVER populate pinned channels
            // if no pinned fingerprint exists. NEVER modify `latest.pinnedCertSha256`!
            if latest.pinnedCertSha256 != nil {
                if let rawLan = mobile.lanTlsUrl,
                   let validLan = try? PairingPayload.validateHttpsEndpoint(rawLan, field: "lanTlsUrl") {
                    updatedEndpoints.lanTls = validLan
                }
                if let rawV6 = mobile.ipv6Url,
                   let validV6 = try? PairingPayload.validateHttpsEndpoint(rawV6, field: "ipv6Url") {
                    let currentIsDomain = updatedEndpoints.ipv6.map { !Self.isIPLiteralEndpoint($0) } ?? false
                    let incomingIsIP = Self.isIPLiteralEndpoint(validV6)
                    if !(currentIsDomain && incomingIsIP) {
                        updatedEndpoints.ipv6 = validV6
                    }
                }
            }
            if let rawTunnel = mobile.tunnelUrl,
               let validTunnel = try? PairingPayload.validateHttpsEndpoint(rawTunnel, field: "tunnelUrl") {
                let currentIsCustom = updatedEndpoints.tunnel.map { !Self.isTemporaryTryCloudflare($0) } ?? false
                let incomingIsTemp = Self.isTemporaryTryCloudflare(validTunnel)
                if !(currentIsCustom && incomingIsTemp) {
                    updatedEndpoints.tunnel = validTunnel
                }
            }

            guard updatedEndpoints != latest.endpoints else {
                return nil
            }

            latest.endpoints = updatedEndpoints
            cachedCredentials = latest
            return (latest, buildStatusLocked())
        }

        if let (latest, updatedStatus) = updateResult {
            try? store.save(latest)
            notifyListeners(updatedStatus)
        }
    }

    private func validatePatchValue(_ rawValue: String?, field: String) throws -> String? {
        guard let rawValue else { return nil }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return try PairingPayload.normalizeHttpsEndpointInput(trimmed, field: field)
    }

    private static func isIPLiteralEndpoint(_ urlString: String) -> Bool {
        guard let host = URLComponents(string: urlString)?.host, !host.isEmpty else {
            return false
        }
        let bare = host.hasPrefix("[") && host.hasSuffix("]")
            ? String(host.dropFirst().dropLast())
            : host
        #if canImport(Network)
        return IPv4Address(bare) != nil || IPv6Address(bare) != nil
        #else
        return bare.contains(":") || bare.split(separator: ".").allSatisfy { Int($0) != nil }
        #endif
    }

    private static func isTemporaryTryCloudflare(_ urlString: String) -> Bool {
        guard let host = URLComponents(string: urlString)?.host?.lowercased() else {
            return false
        }
        return host == "trycloudflare.com" || host.hasSuffix(".trycloudflare.com")
    }

    private func buildStatusLocked() -> NativeEndpointStatus {
        guard let creds = cachedCredentials else {
            return NativeEndpointStatus(
                paired: false,
                activeChannel: nil,
                activeUrl: nil,
                certSha256: nil,
                candidates: EndpointCandidates(),
                pinMismatch: pinMismatch
            )
        }
        return NativeEndpointStatus(
            paired: true,
            activeChannel: pinMismatch == nil ? activeChannel : nil,
            activeUrl: pinMismatch == nil ? activeUrl : nil,
            certSha256: creds.pinnedCertSha256,
            candidates: creds.endpoints,
            pinMismatch: pinMismatch
        )
    }

    private func notifyListeners(_ status: NativeEndpointStatus) {
        lock.lock()
        let currentListeners = Array(listeners.values)
        lock.unlock()
        for listener in currentListeners {
            listener(status)
        }
    }

    #if canImport(Network)
    private static func pathSignature(_ path: NWPath) -> String {
        let interfaces: [String] = [
            path.usesInterfaceType(.wifi) ? "wifi" : nil,
            path.usesInterfaceType(.cellular) ? "cellular" : nil,
            path.usesInterfaceType(.wiredEthernet) ? "ethernet" : nil,
        ].compactMap { $0 }
        return "\(path.status)-\(interfaces.joined(separator: ","))"
    }
    #endif
}
