import Foundation
import Security
import XCTest
#if canImport(VecwayCore)
@testable import VecwayCore
#elseif canImport(Vecway)
@testable import Vecway
#endif

final class PinnedTransportTests: XCTestCase {
    // Real self-signed EC P-256 X.509 certificate DER fixture and its exact OpenSSL SHA-256 fingerprint.
    private let fixtureCertBase64 =
        "MIIBYDCCAQagAwIBAgIUW48y+E5aBvi7JAutgsLGbnPMTfgwCgYIKoZIzj0EAwIw" +
        "FjEUMBIGA1UEAwwLdmVjd2F5LXRlc3QwHhcNMjYxMTIxMDY1MDE1WhcNMzYxMTE4" +
        "MDY1MDE1WjAWMRQwEgYDVQQDDAt2ZWN3YXktdGVzdDBZMBMGByqGSM49AgEGCCqG" +
        "SM49AwEHA0IABEZaIM9SdNOISZ383w2L5/I8ewUAf2RAvrQx/o5KUR0aeTYpbjto" +
        "FUDmd4r3ZnllVh9o7fVm6sz3K92qkDWGftejMjAwMB0GA1UdDgQWBBTsDGTvlKuv" +
        "6aBgb8mKg0Bkvs1w3TAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUC" +
        "IBfyKUiNt/fvuUORHaucYtDN02ey5ZearjqzvCp/sO+rAiEA7kUYL5mvFowITTTK" +
        "C/4s/F/GSZeOMJTT+4pAocafscM="
    private let fixtureExpectedFingerprint =
        "CB:DF:57:08:96:96:17:BB:4B:D6:D7:CF:92:C4:B0:0A:72:14:A1:F5:6E:0D:12:7B:91:B3:34:8E:64:8A:11:7E"

    func testConstantTimeEqual() {
        let a = Data(repeating: 0xAB, count: 32)
        let b = Data(repeating: 0xAB, count: 32)
        var c = Data(repeating: 0xAB, count: 32)
        c[31] ^= 0x01 // flip a single bit in final byte

        XCTAssertTrue(TransportSecurity.constantTimeEqual(a, b))
        XCTAssertFalse(TransportSecurity.constantTimeEqual(a, c))
        XCTAssertFalse(TransportSecurity.constantTimeEqual(a, Data(repeating: 0xAB, count: 31)))
    }

    func testDERSha256FingerprintMatchesOpenSSLAndRustFormat() throws {
        let der = try XCTUnwrap(Data(base64Encoded: fixtureCertBase64))
        let secCert = try XCTUnwrap(SecCertificateCreateWithData(nil, der as CFData))
        let roundTrippedDER = SecCertificateCopyData(secCert) as Data

        let digest = TransportSecurity.sha256Digest(of: roundTrippedDER)
        let formatted = formatSha256Fingerprint(digest)

        XCTAssertEqual(formatted.count, 95)
        XCTAssertEqual(formatted, fixtureExpectedFingerprint)

        let expectedDigest = try XCTUnwrap(parseSha256Fingerprint(fixtureExpectedFingerprint))
        XCTAssertNoThrow(
            try TransportSecurity.verifyLeafCertificateDER(
                roundTrippedDER,
                expectedDigest: expectedDigest,
                expectedHex: fixtureExpectedFingerprint,
                host: "192.168.1.10",
                channel: .lanTls
            )
        )
    }

    func testVerifyLeafCertificateDERThrowsPinMismatchOnSingleByteChange() throws {
        var mutatedDER = try XCTUnwrap(Data(base64Encoded: fixtureCertBase64))
        mutatedDER[mutatedDER.count - 1] ^= 0x01
        let expectedDigest = try XCTUnwrap(parseSha256Fingerprint(fixtureExpectedFingerprint))

        XCTAssertThrowsError(
            try TransportSecurity.verifyLeafCertificateDER(
                mutatedDER,
                expectedDigest: expectedDigest,
                expectedHex: fixtureExpectedFingerprint,
                host: "192.168.1.10",
                channel: .lanTls
            )
        ) { error in
            guard let pinError = error as? PinMismatchError else {
                XCTFail("Expected PinMismatchError, got \(error)")
                return
            }
            XCTAssertEqual(pinError.expectedSha256, fixtureExpectedFingerprint)
            XCTAssertNotEqual(pinError.actualSha256, fixtureExpectedFingerprint)
            XCTAssertEqual(pinError.actualSha256.count, 95)
            XCTAssertEqual(pinError.host, "192.168.1.10")
            XCTAssertEqual(pinError.channel, .lanTls)
        }
    }

    func testPlaintextHttpRejectedBeforeSendingRequestOrPairing() async {
        let transport = PinnedTransport(userAgent: "Vecway-iOS/0.2.0 (iPhone)")

        do {
            _ = try await transport.send(
                channel: .lanTls,
                baseURL: "http://127.0.0.1:7788",
                path: "/api/device",
                method: "GET",
                headers: nil,
                body: nil,
                bearerToken: "secret-token",
                expectedCertSha256: fixtureExpectedFingerprint,
                timeout: 2
            )
            XCTFail("Expected plaintextForbidden error")
        } catch let error as TransportError {
            guard case .plaintextForbidden = error else {
                XCTFail("Expected plaintextForbidden, got \(error)")
                return
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }

        do {
            _ = try await transport.pair(
                channel: .lanTls,
                baseURL: "http://127.0.0.1:7788",
                code: "abc123",
                deviceName: "iPhone",
                expectedCertSha256: fixtureExpectedFingerprint,
                timeout: 2
            )
            XCTFail("Expected plaintextForbidden error on pair")
        } catch let error as TransportError {
            guard case .plaintextForbidden = error else {
                XCTFail("Expected plaintextForbidden, got \(error)")
                return
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testPinnedChannelsRejectMissingOrInvalidFingerprint() async {
        let transport = PinnedTransport(userAgent: "Vecway-iOS/0.2.0 (iPhone)")

        for channel in [NativeChannel.lanTls, NativeChannel.ipv6Tls] {
            do {
                _ = try await transport.send(
                    channel: channel,
                    baseURL: "https://127.0.0.1:7790",
                    path: "/api/device",
                    method: "GET",
                    headers: nil,
                    body: nil,
                    bearerToken: "tok",
                    expectedCertSha256: nil,
                    timeout: 2
                )
                XCTFail("Expected missingCertificatePin for \(channel)")
            } catch let error as TransportError {
                XCTAssertEqual(error, .missingCertificatePin(channel))
            } catch {
                XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testResolveEndpointURLBlocksHostOverrideAndPreservesPercentEncoding() throws {
        let resolved = try TransportSecurity.resolveEndpointURL(
            base: "https://192.168.1.10:7790/",
            path: "/api/sessions/s1/image?path=%2Ftmp%2Fmy%20photo.png"
        )
        XCTAssertEqual(
            resolved.absoluteString,
            "https://192.168.1.10:7790/api/sessions/s1/image?path=%2Ftmp%2Fmy%20photo.png"
        )

        // Protocol-relative host override must be rejected to prevent Bearer token exfiltration.
        XCTAssertThrowsError(
            try TransportSecurity.resolveEndpointURL(base: "https://192.168.1.10:7790", path: "//evil.example/steal")
        )
        XCTAssertThrowsError(
            try TransportSecurity.resolveEndpointURL(base: "https://192.168.1.10:7790", path: "https://evil.example/steal")
        )
        XCTAssertThrowsError(
            try TransportSecurity.resolveEndpointURL(base: "https://192.168.1.10:7790", path: "http://192.168.1.10:7788/api/device")
        )
    }

    func testHeaderSanitizerStripsBrowserHeadersAndInjectsBearerAndUA() {
        let sanitized = HeaderSanitizer.sanitize(
            headers: [
                "Origin": "vecway://app",
                "Referer": "vecway://app/index.html",
                "Cookie": "ompws_token=leaked",
                "Sec-Fetch-Site": "cross-site",
                "sec-fetch-mode": "cors",
                "SEC-FETCH-DEST": "empty",
                "Authorization": "Bearer attacker-override",
                "User-Agent": "Mozilla/5.0",
                "Content-Type": "application/json",
                "Accept": "application/json",
            ],
            bearerToken: "real-device-token",
            userAgent: "Vecway-iOS/0.2.0 (iPhone)"
        )

        XCTAssertNil(sanitized["Origin"])
        XCTAssertNil(sanitized["Referer"])
        XCTAssertNil(sanitized["Cookie"])
        XCTAssertNil(sanitized["Sec-Fetch-Site"])
        XCTAssertNil(sanitized["sec-fetch-mode"])
        XCTAssertNil(sanitized["SEC-FETCH-DEST"])
        XCTAssertEqual(sanitized["Authorization"], "Bearer real-device-token")
        XCTAssertEqual(sanitized["User-Agent"], "Vecway-iOS/0.2.0 (iPhone)")
        XCTAssertEqual(sanitized["Content-Type"], "application/json")
        XCTAssertEqual(sanitized["Accept"], "application/json")
    }

    func testMakeRequestDisablesCookiesAndUsesSanitizedHeaders() throws {
        let transport = PinnedTransport(userAgent: "Vecway-iOS/0.2.0 (iPhone)")
        let url = try XCTUnwrap(URL(string: "https://192.168.1.10:7790/api/sessions"))
        let request = transport.makeRequest(
            url: url,
            method: "post",
            headers: [
                "Origin": "https://evil.test",
                "Cookie": "ompws_token=bad",
                "Content-Type": "application/json",
            ],
            body: Data("{}".utf8),
            bearerToken: "tok_123",
            timeout: 15
        )

        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertFalse(request.httpShouldHandleCookies)
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok_123")
        XCTAssertEqual(request.value(forHTTPHeaderField: "User-Agent"), "Vecway-iOS/0.2.0 (iPhone)")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }
}
