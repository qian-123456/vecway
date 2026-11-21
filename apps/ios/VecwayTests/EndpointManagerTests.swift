import Foundation
import XCTest
#if canImport(VecwayCore)
@testable import VecwayCore
#elseif canImport(Vecway)
@testable import Vecway
#endif

private final class MockHTTPTransport: HTTPTransporting, @unchecked Sendable {
    struct RecordedRequest: Equatable, Sendable {
        let channel: NativeChannel
        let baseURL: String
        let path: String
        let method: String
        let expectedCertSha256: String?
    }

    private let lock = NSLock()
    private var sendHandler: (@Sendable (NativeChannel, String, String, String) async throws -> TransportResponse)?
    private var pairHandler: (@Sendable (NativeChannel, String, String, String?) async throws -> PairExchangeResponse)?
    private(set) var recordedRequests: [RecordedRequest] = []
    private(set) var invalidateCount = 0

    func setSendHandler(
        _ handler: @escaping @Sendable (NativeChannel, String, String, String) async throws -> TransportResponse
    ) {
        lock.lock()
        sendHandler = handler
        lock.unlock()
    }

    func setPairHandler(
        _ handler: @escaping @Sendable (NativeChannel, String, String, String?) async throws -> PairExchangeResponse
    ) {
        lock.lock()
        pairHandler = handler
        lock.unlock()
    }

    func snapshotRequests() -> [RecordedRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recordedRequests
    }

    func clearRecordedRequests() {
        lock.lock()
        recordedRequests.removeAll()
        lock.unlock()
    }

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
    ) async throws -> TransportResponse {
        lock.lock()
        recordedRequests.append(
            RecordedRequest(
                channel: channel,
                baseURL: baseURL,
                path: path,
                method: method,
                expectedCertSha256: expectedCertSha256
            )
        )
        let handler = sendHandler
        lock.unlock()

        guard let handler else {
            throw TransportError.unreachable("no mock handler")
        }
        return try await handler(channel, baseURL, path, method)
    }

    func pair(
        channel: NativeChannel,
        baseURL: String,
        code: String,
        deviceName: String?,
        expectedCertSha256: String?,
        timeout: TimeInterval
    ) async throws -> PairExchangeResponse {
        lock.lock()
        let handler = pairHandler
        lock.unlock()

        guard let handler else {
            throw TransportError.unreachable("no pair mock handler")
        }
        return try await handler(channel, baseURL, code, expectedCertSha256)
    }

    func invalidateSessions() {
        lock.lock()
        invalidateCount += 1
        lock.unlock()
    }
}

final class EndpointManagerTests: XCTestCase {
    private let trustedFP = "CB:DF:57:08:96:96:17:BB:4B:D6:D7:CF:92:C4:B0:0A:72:14:A1:F5:6E:0D:12:7B:91:B3:34:8E:64:8A:11:7E"
    private let attackerFP = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"

    private func makeSeededStore(
        lan: String? = "https://192.168.1.10:7790",
        ipv6: String? = "https://home.example.com:7789",
        tunnel: String? = "https://demo.trycloudflare.com",
        pin: String? = nil
    ) -> InMemoryCredentialStore {
        InMemoryCredentialStore(
            initial: StoredCredentials(
                deviceToken: "device-token-secret",
                pinnedCertSha256: pin ?? trustedFP,
                endpoints: EndpointCandidates(lanTls: lan, ipv6: ipv6, tunnel: tunnel),
                preferredTarget: "lan"
            )
        )
    }

    private static func okJSON(_ object: [String: Any]) -> TransportResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
        return TransportResponse(status: 200, headers: ["Content-Type": "application/json"], body: data)
    }

    func testChannelPriorityLanOverIpv6OverTunnel() async {
        let store = makeSeededStore()
        let mock = MockHTTPTransport()
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        // All 3 channels healthy -> LAN TLS must win without even probing remote channels.
        mock.setSendHandler { _, _, path, _ in
            if path == "/api/device" { return Self.okJSON(["id": "dev1"]) }
            return Self.okJSON([:])
        }
        let s1 = await manager.reprobeConnection()
        XCTAssertEqual(s1.activeChannel, .lanTls)
        XCTAssertEqual(s1.activeUrl, "https://192.168.1.10:7790")

        // LAN unreachable, both IPv6 and Tunnel healthy -> IPv6 TLS must win.
        mock.setSendHandler { channel, _, path, _ in
            if channel == .lanTls { throw TransportError.unreachable("timeout") }
            if path == "/api/device" { return Self.okJSON(["id": "dev1"]) }
            return Self.okJSON([:])
        }
        let s2 = await manager.reprobeConnection()
        XCTAssertEqual(s2.activeChannel, .ipv6Tls)
        XCTAssertEqual(s2.activeUrl, "https://home.example.com:7789")

        // LAN & IPv6 unreachable, Tunnel healthy -> Tunnel must win.
        mock.setSendHandler { channel, _, path, _ in
            if channel != .tunnel { throw TransportError.unreachable("offline") }
            if path == "/api/device" { return Self.okJSON(["id": "dev1"]) }
            return Self.okJSON([:])
        }
        let s3 = await manager.reprobeConnection()
        XCTAssertEqual(s3.activeChannel, .tunnel)
        XCTAssertEqual(s3.activeUrl, "https://demo.trycloudflare.com")
    }

    func testWifiToCellularFailoverAndRecovery() async {
        let store = makeSeededStore(ipv6: nil)
        let mock = MockHTTPTransport()
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        final class NetworkState: @unchecked Sendable {
            private let lock = NSLock()
            var wifiReachable = true
            func get() -> Bool { lock.lock(); defer { lock.unlock() }; return wifiReachable }
            func set(_ v: Bool) { lock.lock(); wifiReachable = v; lock.unlock() }
        }
        let state = NetworkState()

        mock.setSendHandler { channel, _, _, _ in
            if channel == .lanTls && !state.get() {
                throw TransportError.unreachable("cellular")
            }
            return Self.okJSON(["id": "dev1"])
        }

        // On Wi-Fi -> LAN TLS
        let onWifi = await manager.reprobeConnection()
        XCTAssertEqual(onWifi.activeChannel, .lanTls)

        // Switch to cellular -> Tunnel
        state.set(false)
        let onCellular = await manager.reprobeConnection()
        XCTAssertEqual(onCellular.activeChannel, .tunnel)

        // Return to Wi-Fi -> LAN TLS
        state.set(true)
        let backOnWifi = await manager.reprobeConnection()
        XCTAssertEqual(backOnWifi.activeChannel, .lanTls)
    }

    func testDynamicCandidateSyncUpdatesHttpsURLsAndNeverOverwritesPinnedCertSha256() async throws {
        let store = makeSeededStore()
        let mock = MockHTTPTransport()
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        let maliciousFP = attackerFP
        mock.setSendHandler { channel, _, path, _ in
            if channel == .lanTls { throw TransportError.unreachable("old lan ip") }
            if path == "/api/device" {
                return Self.okJSON(["id": "dev1"])
            }
            if path == "/api/left/settings" {
                return Self.okJSON([
                    "mobile": [
                        "lanTlsUrl": "https://192.168.1.99:7790",
                        "ipv6Url": "http://insecure.example.com:7788", // MUST be ignored!
                        "tunnelUrl": "https://fresh.trycloudflare.com",
                        "certSha256": maliciousFP, // MUST NEVER overwrite local pin!
                    ]
                ])
            }
            return Self.okJSON([:])
        }

        let status = await manager.reprobeConnection()
        XCTAssertEqual(status.activeChannel, .ipv6Tls)
        XCTAssertEqual(status.candidates.lanTls, "https://192.168.1.99:7790")
        // Plaintext ipv6Url from settings was rejected; original https ipv6 preserved.
        XCTAssertEqual(status.candidates.ipv6, "https://home.example.com:7789")
        XCTAssertEqual(status.candidates.tunnel, "https://fresh.trycloudflare.com")
        // IRON LAW: Pinned SHA-256 fingerprint MUST NEVER be mutated by /api/left/settings.
        XCTAssertEqual(status.certSha256, trustedFP)
        let saved = try XCTUnwrap(try store.load())
        XCTAssertEqual(saved.pinnedCertSha256, trustedFP)
        XCTAssertEqual(saved.endpoints.lanTls, "https://192.168.1.99:7790")
    }

    func testPinMismatchOnLanHardBlocksImmediatelyWithoutProbingOtherChannels() async {
        let store = makeSeededStore()
        let mock = MockHTTPTransport()
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        let expectedMismatch = NativePinMismatch(
            expectedSha256: trustedFP,
            actualSha256: attackerFP,
            host: "192.168.1.10",
            channel: .lanTls
        )

        mock.setSendHandler { channel, _, _, _ in
            if channel == .lanTls {
                throw TransportError.pinMismatch(expectedMismatch)
            }
            return Self.okJSON(["id": "dev1"])
        }

        let status = await manager.reprobeConnection()
        XCTAssertEqual(status.pinMismatch, expectedMismatch)
        XCTAssertNil(status.activeChannel)
        XCTAssertNil(status.activeUrl)

        // Verify IPv6 and Tunnel were NEVER contacted after LAN pin mismatch.
        let probedChannels = mock.snapshotRequests().map(\.channel)
        XCTAssertEqual(probedChannels, [.lanTls])

        // Subsequent requests MUST remain hard-blocked.
        do {
            _ = try await manager.performRequest(method: "GET", path: "/api/sessions")
            XCTFail("Expected hard-block pinMismatch error")
        } catch let error as TransportError {
            XCTAssertEqual(error, .pinMismatch(expectedMismatch))
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testPinMismatchOnIpv6HardBlocksEvenWhenTunnelIsHealthy() async {
        let store = makeSeededStore()
        let mock = MockHTTPTransport()
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        let ipv6Mismatch = NativePinMismatch(
            expectedSha256: trustedFP,
            actualSha256: attackerFP,
            host: "home.example.com",
            channel: .ipv6Tls
        )

        mock.setSendHandler { channel, _, _, _ in
            switch channel {
            case .lanTls:
                throw TransportError.unreachable("not on wifi")
            case .ipv6Tls:
                throw TransportError.pinMismatch(ipv6Mismatch)
            case .tunnel:
                return Self.okJSON(["id": "dev1"])
            }
        }

        let status = await manager.reprobeConnection()
        XCTAssertEqual(status.pinMismatch, ipv6Mismatch)
        XCTAssertNil(status.activeChannel)
        XCTAssertNil(status.activeUrl)
    }

    func testUpdateEndpointsValidatesHttpsClearsEmptyAndRejectsHttp() async throws {
        let store = makeSeededStore()
        let mock = MockHTTPTransport()
        mock.setSendHandler { _, _, _, _ in Self.okJSON(["id": "dev1"]) }
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        // Reject plaintext http:// without modifying persisted endpoints.
        do {
            _ = try await manager.updateEndpoints(EndpointUpdatePatch(lanTls: .some("http://192.168.1.20:7788")))
            XCTFail("Expected insecureEndpoint error")
        } catch let error as PairingPayloadError {
            guard case .insecureEndpoint(let field, _) = error else {
                XCTFail("Expected insecureEndpoint, got \(error)")
                return
            }
            XCTAssertEqual(field, "lanTls")
        }
        XCTAssertEqual(try store.load()?.endpoints.lanTls, "https://192.168.1.10:7790")

        // Update lanTls with https://, clear ipv6 with "", preserve tunnel by omitting it.
        let updated = try await manager.updateEndpoints(
            EndpointUpdatePatch(
                lanTls: .some("https://192.168.1.55:7790/"),
                ipv6: .some(""),
                tunnel: nil
            )
        )
        XCTAssertEqual(updated.candidates.lanTls, "https://192.168.1.55:7790")
        XCTAssertNil(updated.candidates.ipv6)
        XCTAssertEqual(updated.candidates.tunnel, "https://demo.trycloudflare.com")
        XCTAssertEqual(updated.certSha256, trustedFP)
    }

    func testPairReplacesCredentialsAndClearsPinMismatch() async throws {
        let store = makeSeededStore()
        let mock = MockHTTPTransport()
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        // Trigger a pin mismatch first.
        manager.recordPinMismatch(
            NativePinMismatch(
                expectedSha256: trustedFP,
                actualSha256: attackerFP,
                host: "192.168.1.10",
                channel: .lanTls
            )
        )
        XCTAssertNotNil(manager.currentStatus().pinMismatch)

        let newPayload = PairingPayload(
            version: 1,
            code: "FreshCode_42",
            preferredTarget: .lan,
            endpoints: EndpointCandidates(lanTls: "https://192.168.1.10:7790"),
            certSha256: attackerFP,
            certSha256Digest: parseSha256Fingerprint(attackerFP)
        )

        let expectedNewFP = attackerFP
        mock.setPairHandler { channel, baseURL, code, fp in
            XCTAssertEqual(channel, .lanTls)
            XCTAssertEqual(baseURL, "https://192.168.1.10:7790")
            XCTAssertEqual(code, "FreshCode_42")
            XCTAssertEqual(fp, expectedNewFP)
            return PairExchangeResponse(token: "new-token-xyz", device: PairedDeviceInfo(id: "d2", name: "iPhone"))
        }
        mock.setSendHandler { _, _, _, _ in Self.okJSON([:]) }

        let status = try await manager.pair(payload: newPayload, deviceName: "My iPhone")
        XCTAssertTrue(status.paired)
        XCTAssertNil(status.pinMismatch)
        XCTAssertEqual(status.activeChannel, .lanTls)
        XCTAssertEqual(status.certSha256, attackerFP)
        XCTAssertEqual(try store.load()?.deviceToken, "new-token-xyz")
    }

    func testUnpairWipesStoreAndResetsState() async throws {
        let store = makeSeededStore()
        let mock = MockHTTPTransport()
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        let expectation = expectation(description: "onWillUnpair invoked")
        manager.onWillUnpair = { expectation.fulfill() }

        try await manager.unpair()
        await fulfillment(of: [expectation], timeout: 1.0)

        XCTAssertNil(try store.load())
        let status = manager.currentStatus()
        XCTAssertFalse(status.paired)
        XCTAssertNil(status.activeChannel)
        XCTAssertNil(status.activeUrl)
        XCTAssertNil(status.certSha256)
        XCTAssertNil(status.pinMismatch)
    }

    func testNativeEndpointStatusEncodesExplicitNullsForJSContract() throws {
        let status = NativeEndpointStatus(
            paired: false,
            activeChannel: nil,
            activeUrl: nil,
            preferredChannel: nil,
            certSha256: nil,
            candidates: EndpointCandidates(),
            pinMismatch: nil
        )
        let data = try JSONEncoder().encode(status)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(json["paired"] as? Bool, false)
        XCTAssertTrue(json["activeChannel"] is NSNull)
        XCTAssertTrue(json["activeUrl"] is NSNull)
        XCTAssertTrue(json["preferredChannel"] is NSNull)
        XCTAssertTrue(json["certSha256"] is NSNull)
        XCTAssertTrue(json["pinMismatch"] is NSNull)
        XCTAssertNotNil(json["candidates"] as? [String: Any])

        let pinnedPref = NativeEndpointStatus(
            paired: true,
            activeChannel: .tunnel,
            activeUrl: "https://omp.example.com",
            preferredChannel: .tunnel,
            certSha256: nil,
            candidates: EndpointCandidates(tunnel: "https://omp.example.com"),
            pinMismatch: nil
        )
        let prefData = try JSONEncoder().encode(pinnedPref)
        let prefJson = try XCTUnwrap(try JSONSerialization.jsonObject(with: prefData) as? [String: Any])
        XCTAssertEqual(prefJson["preferredChannel"] as? String, "tunnel")
    }

    func testUpdateEndpointsNormalizesBareDomainAndPreservesCustomDomainsOnSync() async throws {
        let store = makeSeededStore(ipv6: "https://home.example.com:7789", tunnel: nil)
        let mock = MockHTTPTransport()
        mock.setSendHandler { channel, _, path, _ in
            if channel == .lanTls { throw TransportError.unreachable("not on wifi") }
            if path == "/api/device" { return Self.okJSON(["id": "dev1"]) }
            if path == "/api/left/settings" {
                return Self.okJSON([
                    "mobile": [
                        "lanTlsUrl": "https://192.168.1.10:7790",
                        "ipv6Url": "https://[240e:1234::99]:7789",
                        "tunnelUrl": "https://ephemeral.trycloudflare.com",
                    ]
                ])
            }
            return Self.okJSON([:])
        }

        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)
        let updated = try await manager.updateEndpoints(EndpointUpdatePatch(tunnel: .some("omp.example.com/")))

        XCTAssertEqual(updated.candidates.tunnel, "https://omp.example.com")
        // Custom DDNS domain is not overwritten by raw IPv6 literal, and custom CF domain is not overwritten by trycloudflare.
        XCTAssertEqual(updated.candidates.ipv6, "https://home.example.com:7789")
        XCTAssertEqual(updated.candidates.tunnel, "https://omp.example.com")
    }

    func testStoredCredentialsDecodesLegacyPayloadWithoutPreferredChannel() throws {
        let legacyJSON = """
        {
          "deviceToken": "legacy-token",
          "pinnedCertSha256": null,
          "endpoints": { "tunnel": "https://omp.example.com" },
          "preferredTarget": "tunnel"
        }
        """
        let decoded = try JSONDecoder().decode(StoredCredentials.self, from: Data(legacyJSON.utf8))
        XCTAssertEqual(decoded.deviceToken, "legacy-token")
        XCTAssertNil(decoded.pinnedCertSha256)
        XCTAssertEqual(decoded.endpoints.tunnel, "https://omp.example.com")
        XCTAssertNil(decoded.preferredChannel)
    }

    func testSwitchChannelPersistsPreferenceProbesTargetAndFiresActiveChannelCallback() async throws {
        let store = makeSeededStore()
        let mock = MockHTTPTransport()
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        final class ChannelChangeRecorder: @unchecked Sendable {
            private let lock = NSLock()
            private var events: [(NativeChannel?, String?)] = []
            func record(_ channel: NativeChannel?, _ url: String?) {
                lock.lock()
                events.append((channel, url))
                lock.unlock()
            }
            func snapshot() -> [(NativeChannel?, String?)] {
                lock.lock()
                defer { lock.unlock() }
                return events
            }
        }
        let recorder = ChannelChangeRecorder()
        manager.onActiveChannelChanged = { ch, url in
            recorder.record(ch, url)
        }

        mock.setSendHandler { _, _, path, _ in
            if path == "/api/device" { return Self.okJSON(["id": "dev1"]) }
            return Self.okJSON([:])
        }

        // Initial auto reprobe selects LAN TLS.
        let initial = await manager.reprobeConnection()
        XCTAssertEqual(initial.activeChannel, .lanTls)
        XCTAssertNil(initial.preferredChannel)
        XCTAssertEqual(recorder.snapshot().count, 1)
        XCTAssertEqual(recorder.snapshot().last?.0, .lanTls)

        // Explicitly switch to Tunnel -> probes Tunnel, persists preference, fires callback.
        let switchedToTunnel = try await manager.switchChannel(.tunnel)
        XCTAssertEqual(switchedToTunnel.activeChannel, .tunnel)
        XCTAssertEqual(switchedToTunnel.activeUrl, "https://demo.trycloudflare.com")
        XCTAssertEqual(switchedToTunnel.preferredChannel, .tunnel)
        XCTAssertEqual(try store.load()?.preferredChannel, .tunnel)
        XCTAssertEqual(recorder.snapshot().count, 2)
        XCTAssertEqual(recorder.snapshot().last?.0, .tunnel)
        XCTAssertEqual(recorder.snapshot().last?.1, "https://demo.trycloudflare.com")

        // Subsequent reprobeConnection respects persisted preferredChannel (.tunnel) even when LAN is healthy.
        mock.clearRecordedRequests()
        let reprobedTunnel = await manager.reprobeConnection()
        XCTAssertEqual(reprobedTunnel.activeChannel, .tunnel)
        XCTAssertEqual(reprobedTunnel.preferredChannel, .tunnel)
        let deviceProbeChannels = mock.snapshotRequests().filter { $0.path == "/api/device" }.map(\.channel)
        XCTAssertEqual(deviceProbeChannels, [.tunnel])
        // Channel did not change, so callback MUST NOT fire redundantly.
        XCTAssertEqual(recorder.snapshot().count, 2)

        // Switch explicitly back to LAN TLS.
        let switchedToLan = try await manager.switchChannel(.lanTls)
        XCTAssertEqual(switchedToLan.activeChannel, .lanTls)
        XCTAssertEqual(switchedToLan.activeUrl, "https://192.168.1.10:7790")
        XCTAssertEqual(switchedToLan.preferredChannel, .lanTls)
        XCTAssertEqual(try store.load()?.preferredChannel, .lanTls)
        XCTAssertEqual(recorder.snapshot().count, 3)
        XCTAssertEqual(recorder.snapshot().last?.0, .lanTls)

        // Switch back to Auto (`nil`) -> clears preferredChannel and reprobes auto priority.
        let switchedToAuto = try await manager.switchChannel(nil)
        XCTAssertEqual(switchedToAuto.activeChannel, .lanTls)
        XCTAssertNil(switchedToAuto.preferredChannel)
        XCTAssertNil(try store.load()?.preferredChannel)
    }

    func testSwitchChannelThrowsWhenUnreachableOrUnconfiguredAndKeepsPreviousChannel() async throws {
        let store = makeSeededStore(ipv6: nil)
        let mock = MockHTTPTransport()
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        mock.setSendHandler { channel, _, path, _ in
            if channel == .lanTls {
                throw TransportError.unreachable("not on home wifi")
            }
            if path == "/api/device" { return Self.okJSON(["id": "dev1"]) }
            return Self.okJSON([:])
        }

        // Auto connects via Tunnel while LAN is unreachable.
        let initial = await manager.reprobeConnection()
        XCTAssertEqual(initial.activeChannel, .tunnel)

        // Attempting to switch to unreachable LAN throws and preserves Tunnel state.
        do {
            _ = try await manager.switchChannel(.lanTls)
            XCTFail("Expected unreachable error when switching to offline LAN")
        } catch let error as TransportError {
            guard case .unreachable(let msg) = error else {
                XCTFail("Expected unreachable, got \(error)")
                return
            }
            XCTAssertTrue(msg.contains("局域网 TLS"), "Unexpected message: \(msg)")
        }
        XCTAssertEqual(manager.currentStatus().activeChannel, .tunnel)
        XCTAssertNil(try store.load()?.preferredChannel)

        // Attempting to switch to unconfigured IPv6 channel throws clear error.
        do {
            _ = try await manager.switchChannel(.ipv6Tls)
            XCTFail("Expected unreachable error for unconfigured channel")
        } catch let error as TransportError {
            guard case .unreachable(let msg) = error else {
                XCTFail("Expected unreachable, got \(error)")
                return
            }
            XCTAssertTrue(msg.contains("尚未配置"), "Unexpected message: \(msg)")
        }
    }

    func testReprobeFallsBackWhenPreferredChannelIsUnreachable() async throws {
        let store = InMemoryCredentialStore(
            initial: StoredCredentials(
                deviceToken: "device-token-secret",
                pinnedCertSha256: trustedFP,
                endpoints: EndpointCandidates(
                    lanTls: "https://192.168.1.10:7790",
                    ipv6: nil,
                    tunnel: "https://demo.trycloudflare.com"
                ),
                preferredTarget: "tunnel",
                preferredChannel: .tunnel
            )
        )
        let mock = MockHTTPTransport()
        mock.setSendHandler { channel, _, path, _ in
            if channel == .tunnel {
                throw TransportError.unreachable("tunnel down")
            }
            if path == "/api/device" { return Self.okJSON(["id": "dev1"]) }
            return Self.okJSON([:])
        }

        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)
        let status = await manager.reprobeConnection()

        // Probed preferred channel (.tunnel) first, then cleanly fell back to .lanTls.
        let deviceProbes = mock.snapshotRequests().filter { $0.path == "/api/device" }.map(\.channel)
        XCTAssertEqual(deviceProbes, [.tunnel, .lanTls])
        XCTAssertEqual(status.activeChannel, .lanTls)
        XCTAssertEqual(status.preferredChannel, .tunnel)
    }

    func testUpdateEndpointsAdoptsCertSha256OnlyWhenNilAndStrictlyRejectsOverwrite() async throws {
        // Domain-paired credentials start with nil pinnedCertSha256 and only a CA-verified tunnel URL.
        let store = InMemoryCredentialStore(
            initial: StoredCredentials(
                deviceToken: "domain-device-token",
                pinnedCertSha256: nil,
                endpoints: EndpointCandidates(lanTls: nil, ipv6: nil, tunnel: "https://omp.example.com"),
                preferredTarget: "tunnel"
            )
        )
        let mock = MockHTTPTransport()
        mock.setSendHandler { _, _, path, _ in
            if path == "/api/device" { return Self.okJSON(["id": "dev1"]) }
            return Self.okJSON([:])
        }
        let manager = EndpointManager(store: store, transport: mock, lanProbeTimeout: 0.5, remoteProbeTimeout: 1.0)

        // Adding lanTls without a certificate fingerprint MUST fail with missingCertificatePin.
        do {
            _ = try await manager.updateEndpoints(EndpointUpdatePatch(lanTls: .some("https://192.168.1.10:7790")))
            XCTFail("Expected missingCertificatePin error")
        } catch let error as TransportError {
            XCTAssertEqual(error, .missingCertificatePin(.lanTls))
        }
        XCTAssertNil(try store.load()?.pinnedCertSha256)

        // Malformed fingerprint MUST fail with invalidFingerprint and leave store untouched.
        do {
            _ = try await manager.updateEndpoints(
                EndpointUpdatePatch(lanTls: .some("https://192.168.1.10:7790"), certSha256: "not-a-valid-fp")
            )
            XCTFail("Expected invalidFingerprint error")
        } catch let error as PairingPayloadError {
            XCTAssertEqual(error, .invalidFingerprint)
        }
        XCTAssertNil(try store.load()?.pinnedCertSha256)

        // Initial pin adoption when pinnedCertSha256 == nil MUST succeed.
        let adopted = try await manager.updateEndpoints(
            EndpointUpdatePatch(lanTls: .some("https://192.168.1.10:7790"), certSha256: trustedFP)
        )
        XCTAssertEqual(adopted.certSha256, trustedFP)
        XCTAssertEqual(adopted.candidates.lanTls, "https://192.168.1.10:7790")
        XCTAssertEqual(adopted.activeChannel, .lanTls)
        XCTAssertEqual(try store.load()?.pinnedCertSha256, trustedFP)

        // SECURITY INVARIANT: Attempting to mutate an existing non-nil pin MUST throw invalidCertificatePin.
        do {
            _ = try await manager.updateEndpoints(
                EndpointUpdatePatch(lanTls: .some("https://192.168.1.99:7790"), certSha256: attackerFP)
            )
            XCTFail("Expected invalidCertificatePin error when mutating existing pin")
        } catch let error as TransportError {
            XCTAssertEqual(error, .invalidCertificatePin)
        }
        XCTAssertEqual(try store.load()?.pinnedCertSha256, trustedFP)
        XCTAssertEqual(try store.load()?.endpoints.lanTls, "https://192.168.1.10:7790")

        // Passing the exact same existing fingerprint remains idempotent.
        let idempotent = try await manager.updateEndpoints(
            EndpointUpdatePatch(lanTls: .some("https://192.168.1.50:7790"), certSha256: trustedFP)
        )
        XCTAssertEqual(idempotent.certSha256, trustedFP)
        XCTAssertEqual(idempotent.candidates.lanTls, "https://192.168.1.50:7790")
    }
}
