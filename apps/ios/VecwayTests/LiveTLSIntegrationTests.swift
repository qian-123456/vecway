#if os(macOS)
import Foundation
import XCTest
#if canImport(VecwayCore)
@testable import VecwayCore
#elseif canImport(Vecway)
@testable import Vecway
#endif

/// End-to-end live-socket TLS integration tests exercising real `URLSession` + `PinningSessionDelegate`
/// + `PinnedTransport` + `EndpointManager` + `SSEBridge` against a real local self-signed HTTPS server
/// whose certificate intentionally omits the `127.0.0.1` IP SAN (matching desktop `tls.rs` LAN IPv4 behavior).
final class LiveTLSIntegrationTests: XCTestCase {
    private struct LiveServerHandle {
        let process: Process
        let port: Int
        let certFingerprint: String
        let tempDir: URL
        let logFile: URL

        func stop() {
            if process.isRunning {
                process.terminate()
                process.waitUntilExit()
            }
            try? FileManager.default.removeItem(at: tempDir)
        }
    }

    private func startLocalTLSServer() throws -> LiveServerHandle {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vecway-live-tls-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

        let keyPath = tempDir.appendingPathComponent("key.pem").path
        let certPath = tempDir.appendingPathComponent("cert.pem").path
        let certDerPath = tempDir.appendingPathComponent("cert.der").path
        let portFile = tempDir.appendingPathComponent("port.txt")
        let logFile = tempDir.appendingPathComponent("requests.jsonl")
        let scriptFile = tempDir.appendingPathComponent("server.py")

        // Generate self-signed EC P-256 cert with ONLY DNS:localhost (no 127.0.0.1 IP SAN).
        let gen = Process()
        gen.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        gen.arguments = [
            "openssl", "req", "-x509",
            "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-keyout", keyPath,
            "-out", certPath,
            "-days", "1",
            "-subj", "/CN=vecway-lan-test.local",
            "-addext", "subjectAltName=DNS:localhost",
        ]
        gen.standardOutput = Pipe()
        gen.standardError = Pipe()
        try gen.run()
        gen.waitUntilExit()
        XCTAssertEqual(gen.terminationStatus, 0, "openssl cert generation failed")

        let toDer = Process()
        toDer.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        toDer.arguments = ["openssl", "x509", "-in", certPath, "-outform", "DER", "-out", certDerPath]
        toDer.standardOutput = Pipe()
        toDer.standardError = Pipe()
        try toDer.run()
        toDer.waitUntilExit()
        XCTAssertEqual(toDer.terminationStatus, 0, "openssl DER conversion failed")

        let derBytes = try Data(contentsOf: URL(fileURLWithPath: certDerPath))
        let fingerprint = CertificateFingerprint.format(TransportSecurity.sha256Digest(of: derBytes))

        let pythonScript = """
        import http.server, json, ssl, sys, threading

        port_file, log_file, cert_path, key_path = sys.argv[1:5]
        VALID_CODE = "LIVE_PAIR_CODE_123"
        ISSUED_TOKEN = "live_tok_secret_xyz"
        state = {"revoked": False}

        def record(entry):
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\\n")

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, fmt, *args):
                pass

            def _send_json(self, status, obj):
                raw = json.dumps(obj).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _record_req(self):
                record({
                    "method": self.command,
                    "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                })

            def _check_auth(self):
                auth = self.headers.get("Authorization", "")
                if state["revoked"] or auth != f"Bearer {ISSUED_TOKEN}":
                    self._send_json(401, {"error": "unauthorized"})
                    return False
                return True

            def do_GET(self):
                self._record_req()
                if self.path == "/api/device":
                    if not self._check_auth():
                        return
                    self._send_json(200, {"id": "dev-live-1", "name": "iPhone"})
                elif self.path == "/api/left/settings":
                    if not self._check_auth():
                        return
                    self._send_json(200, {"mobile": {"running": True, "certSha256": "FF:" * 31 + "FF"}})
                elif self.path == "/api/events":
                    if not self._check_auth():
                        return
                    body = b'event: hello\\ndata: {}\\n\\nevent: rpc\\ndata: {"type":"live","ok":true}\\n\\n'
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    self.wfile.flush()
                else:
                    self._send_json(404, {"error": "not found"})

            def do_POST(self):
                self._record_req()
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length > 0 else b"{}"
                payload = json.loads(raw.decode("utf-8") or "{}")
                if self.path == "/pair":
                    if payload.get("code") == VALID_CODE and payload.get("returnToken") is True:
                        self._send_json(200, {
                            "token": ISSUED_TOKEN,
                            "device": {"id": "dev-live-1", "name": "iPhone"},
                        })
                    else:
                        self._send_json(403, {"error": "invalid pairing"})
                elif self.path == "/api/echo":
                    if not self._check_auth():
                        return
                    self._send_json(200, {
                        "echo": payload,
                        "seenHeaders": {k.lower(): v for k, v in self.headers.items()},
                    })
                elif self.path == "/api/revoke-self":
                    if not self._check_auth():
                        return
                    state["revoked"] = True
                    self._send_json(200, {"revoked": True})
                else:
                    self._send_json(404, {"error": "not found"})

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        port = server.server_address[1]
        with open(port_file, "w", encoding="utf-8") as f:
            f.write(str(port))
        server.serve_forever()
        """
        try pythonScript.write(to: scriptFile, atomically: true, encoding: .utf8)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["python3", scriptFile.path, portFile.path, logFile.path, certPath, keyPath]
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try proc.run()

        // Wait up to 3s for port file
        var port: Int?
        for _ in 0..<60 {
            if let text = try? String(contentsOf: portFile, encoding: .utf8),
               let parsed = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)),
               parsed > 0 {
                port = parsed
                break
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        guard let boundPort = port else {
            proc.terminate()
            XCTFail("Local TLS server failed to start")
            throw TransportError.unreachable("server start failed")
        }

        return LiveServerHandle(
            process: proc,
            port: boundPort,
            certFingerprint: fingerprint,
            tempDir: tempDir,
            logFile: logFile
        )
    }

    func testLiveTLSPairingHeaderSanitizationSSERevocationAndPinMismatchHardBlock() async throws {
        let server = try startLocalTLSServer()
        defer { server.stop() }

        let lanTlsUrl = "https://127.0.0.1:\(server.port)"
        let appJSON = """
        {"v":1,"t":"lan","lt":"\(lanTlsUrl)","fp":"\(server.certFingerprint)"}
        """
        let b64 = Data(appJSON.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        // Dual-use QR with outer plaintext http:// prefix — MUST be ignored in favor of pinned https://
        let dualUseQR = "http://127.0.0.1:7788/pair?code=LIVE_PAIR_CODE_123#app=\(b64)"
        let payload = try PairingPayload.parse(dualUseQR)

        let store = InMemoryCredentialStore()
        let transport = PinnedTransport(userAgent: "Vecway-iOS/0.2.0 (iPhone)")
        let manager = EndpointManager(
            store: store,
            transport: transport,
            lanProbeTimeout: 2.0,
            remoteProbeTimeout: 3.0
        )

        // 1. Live TLS pairing (IP 127.0.0.1 NOT in cert SAN — succeeds strictly because leaf DER SHA-256 matches!)
        let pairedStatus = try await manager.pair(payload: payload)
        XCTAssertTrue(pairedStatus.paired)
        XCTAssertEqual(pairedStatus.activeChannel, .lanTls)
        XCTAssertEqual(pairedStatus.activeUrl, lanTlsUrl)
        // Server returned fake certSha256 "FF:FF:..." in /api/left/settings; local pin MUST remain unchanged!
        XCTAssertEqual(pairedStatus.certSha256, server.certFingerprint)
        XCTAssertNil(pairedStatus.pinMismatch)

        // 2. Authenticated POST strips browser CSRF headers & injects Bearer + Vecway-iOS UA
        let echoResp = try await manager.performRequest(
            method: "POST",
            path: "/api/echo",
            headers: [
                "Content-Type": "application/json",
                "Origin": "vecway://app",
                "Referer": "vecway://app/index.html",
                "Cookie": "ompws_token=poison",
                "Sec-Fetch-Site": "cross-site",
                "Sec-Fetch-Mode": "cors",
            ],
            body: Data(#"{"hello":"vecway"}"#.utf8)
        )
        XCTAssertEqual(echoResp.status, 200)
        let echoObj = try XCTUnwrap(JSONSerialization.jsonObject(with: echoResp.body) as? [String: Any])
        let seenHeaders = try XCTUnwrap(echoObj["seenHeaders"] as? [String: String])
        XCTAssertEqual(seenHeaders["authorization"], "Bearer live_tok_secret_xyz")
        XCTAssertEqual(seenHeaders["user-agent"], "Vecway-iOS/0.2.0 (iPhone)")
        XCTAssertNil(seenHeaders["origin"])
        XCTAssertNil(seenHeaders["referer"])
        XCTAssertNil(seenHeaders["cookie"])
        XCTAssertNil(seenHeaders["sec-fetch-site"])
        XCTAssertNil(seenHeaders["sec-fetch-mode"])

        // 3. Real SSE over pinned TLS receives hello + rpc events
        final class EventCollector: @unchecked Sendable {
            private let lock = NSLock()
            private var items: [SSEEvent] = []
            func append(_ event: SSEEvent) {
                lock.withLock { items.append(event) }
            }
            func snapshot() -> [SSEEvent] {
                lock.withLock { items }
            }
        }
        let sseBridge = SSEBridge(userAgent: "Vecway-iOS/0.2.0 (iPhone)")
        let openExp = expectation(description: "sse open")
        let rpcExp = expectation(description: "sse rpc")
        let collector = EventCollector()

        sseBridge.open(
            streamId: "live-events",
            channel: .lanTls,
            baseURL: lanTlsUrl,
            path: "/api/events",
            bearerToken: "live_tok_secret_xyz",
            expectedCertSha256: server.certFingerprint,
            callbacks: SSEStreamCallbacks(
                onOpen: { openExp.fulfill() },
                onEvent: { type, data in
                    collector.append(SSEEvent(type: type, data: data))
                    if type == "rpc" {
                        rpcExp.fulfill()
                    }
                },
                onError: { _ in },
                onUnauthorized: { XCTFail("Unexpected 401 on valid SSE token") },
                onPinMismatch: { mismatch in XCTFail("Unexpected pin mismatch: \(mismatch)") }
            )
        )
        await fulfillment(of: [openExp, rpcExp], timeout: 5.0)
        sseBridge.closeAll()
        let received = collector.snapshot()
        XCTAssertTrue(received.contains(SSEEvent(type: "hello", data: "{}")))
        XCTAssertTrue(received.contains(SSEEvent(type: "rpc", data: #"{"type":"live","ok":true}"#)))

        // 4. Plaintext http:// hard-blocked before any socket connection
        do {
            _ = try await transport.send(
                channel: .lanTls,
                baseURL: "http://127.0.0.1:\(server.port)",
                path: "/api/device",
                method: "GET",
                bearerToken: "live_tok_secret_xyz",
                expectedCertSha256: server.certFingerprint,
                timeout: 2.0
            )
            XCTFail("Plaintext http:// request MUST be rejected")
        } catch let error as TransportError {
            if case .plaintextForbidden = error {
                // expected
            } else {
                XCTFail("Expected plaintextForbidden, got \(error)")
            }
        }

        // 5. Revocation -> 401 triggers unauthorized callback immediately
        let unauthExp = expectation(description: "unauthorized signaled")
        manager.onUnauthorized = { unauthExp.fulfill() }
        let revResp = try await manager.performRequest(method: "POST", path: "/api/revoke-self")
        XCTAssertEqual(revResp.status, 200)
        let afterRev = try await manager.performRequest(method: "GET", path: "/api/device")
        XCTAssertEqual(afterRev.status, 401)
        await fulfillment(of: [unauthExp], timeout: 2.0)

        // 6. WRONG CERT FINGERPRINT HARD BLOCK OVER REAL TLS HANDSHAKE (mutate 1 char!)
        let mutatedPin = (server.certFingerprint.hasPrefix("0") ? "1" : "0") + server.certFingerprint.dropFirst()
        let badStore = InMemoryCredentialStore(
            initial: StoredCredentials(
                deviceToken: "live_tok_secret_xyz",
                pinnedCertSha256: mutatedPin,
                endpoints: EndpointCandidates(lanTls: lanTlsUrl)
            )
        )
        let badTransport = PinnedTransport(userAgent: "Vecway-iOS/0.2.0 (iPhone)")
        let badManager = EndpointManager(
            store: badStore,
            transport: badTransport,
            lanProbeTimeout: 2.0,
            remoteProbeTimeout: 3.0
        )

        let reqCountBefore = ((try? String(contentsOf: server.logFile, encoding: .utf8)) ?? "")
            .split(separator: "\n").count

        let blockedStatus = await badManager.reprobeConnection()
        XCTAssertNil(blockedStatus.activeChannel)
        XCTAssertNil(blockedStatus.activeUrl)
        let mismatch = try XCTUnwrap(blockedStatus.pinMismatch)
        XCTAssertEqual(mismatch.expectedSha256, mutatedPin)
        XCTAssertEqual(mismatch.actualSha256, server.certFingerprint)
        XCTAssertEqual(mismatch.host, "127.0.0.1")
        XCTAssertEqual(mismatch.channel, .lanTls)

        // ZERO HTTP request reached the server because TLS handshake was aborted!
        let reqCountAfter = ((try? String(contentsOf: server.logFile, encoding: .utf8)) ?? "")
            .split(separator: "\n").count
        XCTAssertEqual(reqCountAfter, reqCountBefore)

        // Subsequent requests stay hard-blocked
        do {
            _ = try await badManager.performRequest(method: "GET", path: "/api/device")
            XCTFail("Expected latched pinMismatch hard block")
        } catch let error as TransportError {
            XCTAssertEqual(error, .pinMismatch(mismatch))
        }
    }
}
#endif
