import Foundation
import XCTest
#if canImport(VecwayCore)
@testable import VecwayCore
#elseif canImport(Vecway)
@testable import Vecway
#endif

final class PairingPayloadTests: XCTestCase {
    private let validFingerprint = "CB:DF:57:08:96:96:17:BB:4B:D6:D7:CF:92:C4:B0:0A:72:14:A1:F5:6E:0D:12:7B:91:B3:34:8E:64:8A:11:7E"

    private func encodeBase64URL(_ json: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: json, options: [])
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    func testDualUseQRPayloadIgnoresPlaintextHttpPrefix() throws {
        let appJson: [String: Any] = [
            "v": 1,
            "t": "lan",
            "lt": "https://192.168.1.10:7790",
            "fp": validFingerprint,
            "v6": "https://home.example.com:7789",
            "tn": "https://vecway-demo.trycloudflare.com",
        ]
        let encoded = try encodeBase64URL(appJson)
        let dualUseURL = "http://192.168.1.10:7788/pair?code=Pair_Code-01#app=\(encoded)"

        let payload = try PairingPayload.parse(dualUseURL)
        XCTAssertEqual(payload.version, 1)
        XCTAssertEqual(payload.code, "Pair_Code-01")
        XCTAssertEqual(payload.preferredTarget, .lan)
        XCTAssertEqual(payload.endpoints.lanTls, "https://192.168.1.10:7790")
        XCTAssertEqual(payload.endpoints.ipv6, "https://home.example.com:7789")
        XCTAssertEqual(payload.endpoints.tunnel, "https://vecway-demo.trycloudflare.com")
        XCTAssertEqual(payload.certSha256, validFingerprint)
        XCTAssertEqual(payload.certSha256Digest?.count, 32)
        // Confirm plaintext port 7788 never leaks into any endpoint candidate.
        XCTAssertFalse(payload.orderedPairingAttempts().contains { $0.url.contains("7788") || $0.url.hasPrefix("http://") })
    }

    func testDirectVecwayPairURLParsingIncludingIPv6Literal() throws {
        var comps = URLComponents(string: "vecway://pair")!
        comps.queryItems = [
            URLQueryItem(name: "v", value: "1"),
            URLQueryItem(name: "code", value: "abcXYZ_123-9"),
            URLQueryItem(name: "t", value: "ipv6"),
            URLQueryItem(name: "lt", value: "https://10.0.0.5:7790/"),
            URLQueryItem(name: "v6", value: "https://[240e:1234::42]:7789"),
            URLQueryItem(name: "tn", value: "https://tunnel.vecway.dev/"),
            URLQueryItem(name: "fp", value: validFingerprint),
        ]

        let payload = try PairingPayload.parse(comps.string!)
        XCTAssertEqual(payload.code, "abcXYZ_123-9")
        XCTAssertEqual(payload.preferredTarget, .ipv6)
        XCTAssertEqual(payload.endpoints.lanTls, "https://10.0.0.5:7790")
        XCTAssertEqual(payload.endpoints.ipv6, "https://[240e:1234::42]:7789")
        XCTAssertEqual(payload.endpoints.tunnel, "https://tunnel.vecway.dev")
        XCTAssertEqual(payload.certSha256, validFingerprint)

        let attempts = payload.orderedPairingAttempts()
        XCTAssertEqual(attempts.map(\.channel), [.ipv6Tls, .lanTls, .tunnel])
    }

    func testRejectsPlaintextHttpInAllEndpointFields() throws {
        for field in ["lt", "v6", "tn"] {
            var json: [String: Any] = [
                "v": 1,
                "fp": validFingerprint,
                field: "http://192.168.1.10:7788",
            ]
            if field == "tn" {
                json.removeValue(forKey: "fp")
            }
            let encoded = try encodeBase64URL(json)
            let url = "https://192.168.1.10:7790/pair?code=okCode123#app=\(encoded)"

            XCTAssertThrowsError(try PairingPayload.parse(url)) { error in
                guard case PairingPayloadError.insecureEndpoint(let badField, _) = error else {
                    XCTFail("Expected insecureEndpoint for \(field), got \(error)")
                    return
                }
                XCTAssertEqual(badField, field)
            }
        }
    }

    func testRejectsMalformedFingerprints() throws {
        let invalidFingerprints = [
            validFingerprint.lowercased(), // lowercase hex rejected
            String(validFingerprint.dropLast(3)), // too short (31 bytes)
            validFingerprint.replacingOccurrences(of: ":", with: ""), // missing colons
            validFingerprint.replacingOccurrences(of: "A", with: "G"), // non-hex char
        ]

        for badFP in invalidFingerprints {
            XCTAssertNil(parseSha256Fingerprint(badFP), "Expected nil for malformed fp: \(badFP)")
            let encoded = try encodeBase64URL([
                "v": 1,
                "lt": "https://192.168.1.10:7790",
                "fp": badFP,
            ])
            let url = "http://192.168.1.10:7788/pair?code=validCode#app=\(encoded)"
            XCTAssertThrowsError(try PairingPayload.parse(url)) { error in
                XCTAssertEqual(error as? PairingPayloadError, .invalidFingerprint)
            }
        }
    }

    func testRequiresFingerprintForLanAndIPv6Endpoints() throws {
        for field in ["lt", "v6"] {
            let encoded = try encodeBase64URL([
                "v": 1,
                field: "https://192.168.1.10:7790",
            ])
            let url = "http://192.168.1.10:7788/pair?code=validCode#app=\(encoded)"
            XCTAssertThrowsError(try PairingPayload.parse(url)) { error in
                XCTAssertEqual(error as? PairingPayloadError, .missingFingerprintForPinnedEndpoint)
            }
        }
    }

    func testAllowsTunnelOnlyWithoutFingerprint() throws {
        let encoded = try encodeBase64URL([
            "v": 1,
            "t": "tunnel",
            "tn": "https://remote.trycloudflare.com",
        ])
        let url = "https://remote.trycloudflare.com/pair?code=tunnelCode99#app=\(encoded)"
        let payload = try PairingPayload.parse(url)
        XCTAssertEqual(payload.endpoints.tunnel, "https://remote.trycloudflare.com")
        XCTAssertNil(payload.endpoints.lanTls)
        XCTAssertNil(payload.endpoints.ipv6)
        XCTAssertNil(payload.certSha256)
        XCTAssertEqual(payload.orderedPairingAttempts().map(\.channel), [.tunnel])
    }

    func testRejectsInvalidCodeAndUnsupportedVersionAndNoEndpoints() throws {
        let validEncoded = try encodeBase64URL([
            "v": 1,
            "tn": "https://remote.trycloudflare.com",
        ])
        XCTAssertThrowsError(try PairingPayload.parse("http://192.168.1.10:7788/pair?code=../bad#app=\(validEncoded)")) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidCode)
        }

        let v2Encoded = try encodeBase64URL([
            "v": 2,
            "tn": "https://remote.trycloudflare.com",
        ])
        XCTAssertThrowsError(try PairingPayload.parse("http://192.168.1.10:7788/pair?code=valid123#app=\(v2Encoded)")) { error in
            XCTAssertEqual(error as? PairingPayloadError, .unsupportedVersion(2))
        }

        let emptyEndpoints = try encodeBase64URL(["v": 1])
        XCTAssertThrowsError(try PairingPayload.parse("http://192.168.1.10:7788/pair?code=valid123#app=\(emptyEndpoints)")) { error in
            XCTAssertEqual(error as? PairingPayloadError, .noEndpoints)
        }
    }

    func testFingerprintRoundTripAndAbbreviation() throws {
        let digest = try XCTUnwrap(parseSha256Fingerprint(validFingerprint))
        XCTAssertEqual(digest.count, 32)
        XCTAssertEqual(formatSha256Fingerprint(digest), validFingerprint)
        XCTAssertEqual(
            CertificateFingerprint.abbreviated(validFingerprint),
            "CB:DF:57:08 … 64:8A:11:7E"
        )
    }

    func testHttpsDualUseURLWithoutAppFragmentFallsBackToSystemCADomain() throws {
        let url = "https://omp.example.com/pair?code=DomainCode_1"
        let payload = try PairingPayload.parse(url)
        XCTAssertEqual(payload.code, "DomainCode_1")
        XCTAssertEqual(payload.preferredTarget, .tunnel)
        XCTAssertEqual(payload.endpoints.tunnel, "https://omp.example.com")
        XCTAssertNil(payload.endpoints.lanTls)
        XCTAssertNil(payload.endpoints.ipv6)
        XCTAssertNil(payload.certSha256)
        XCTAssertEqual(payload.orderedPairingAttempts().map(\.channel), [.tunnel])

        // Plaintext http:// without `#app=` MUST still be rejected with clear guidance.
        XCTAssertThrowsError(try PairingPayload.parse("http://omp.example.com/pair?code=DomainCode_1")) { error in
            XCTAssertEqual(error as? PairingPayloadError, .missingAppPayload)
            let description = error.localizedDescription
            XCTAssertTrue(description.contains("局域网加密"), "Unexpected description: \(description)")
            XCTAssertTrue(description.contains("用域名或链接配对"), "Unexpected description: \(description)")
        }
    }

    func testFromDomainInputSupportsBareDomainFullPairURLAndOptionalFingerprint() throws {
        // 1. Bare Cloudflare domain + manual pairing code -> system-CA tunnel channel
        let bare = try PairingPayload.fromDomainInput(domainOrURL: "omp.example.com/", code: "CfCode_01")
        XCTAssertEqual(bare.code, "CfCode_01")
        XCTAssertEqual(bare.preferredTarget, .tunnel)
        XCTAssertEqual(bare.endpoints.tunnel, "https://omp.example.com")
        XCTAssertNil(bare.certSha256)

        // 2. Full https://.../pair?code=... URL pasted into domain field with empty code field
        let fromUrl = try PairingPayload.fromDomainInput(
            domainOrURL: "https://omp.example.com:8443/pair?code=Extracted_77",
            code: "  "
        )
        XCTAssertEqual(fromUrl.code, "Extracted_77")
        XCTAssertEqual(fromUrl.endpoints.tunnel, "https://omp.example.com:8443")
        XCTAssertEqual(PairingPayload.extractCodeFromInput("https://omp.example.com/pair?code=Extracted_77"), "Extracted_77")

        // 3. Bare DDNS domain:port + optional self-signed fingerprint -> pinned ipv6Tls
        let ddns = try PairingPayload.fromDomainInput(
            domainOrURL: "home.example.com:7789",
            code: "DdnsCode_2",
            certSha256: validFingerprint
        )
        XCTAssertEqual(ddns.preferredTarget, .ipv6)
        XCTAssertEqual(ddns.endpoints.ipv6, "https://home.example.com:7789")
        XCTAssertEqual(ddns.certSha256, validFingerprint)

        // 4. Explicit plaintext http:// MUST be rejected
        XCTAssertThrowsError(try PairingPayload.fromDomainInput(domainOrURL: "http://omp.example.com", code: "Bad_1")) { error in
            guard case PairingPayloadError.insecureEndpoint(let field, _) = error else {
                XCTFail("Expected insecureEndpoint, got \(error)")
                return
            }
            XCTAssertEqual(field, "domain")
        }
    }
}
