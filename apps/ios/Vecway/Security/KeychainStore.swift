import Foundation
import Security

/// Device credentials and pinned server metadata stored strictly in native Keychain.
/// Never exposed to WebView storage (`localStorage`, `sessionStorage`, `document.cookie`) or JS globals.
public struct StoredCredentials: Codable, Equatable, Sendable {
    public var deviceToken: String
    public var pinnedCertSha256: String?
    public var endpoints: EndpointCandidates
    public var preferredTarget: String?
    public var preferredChannel: NativeChannel?

    public init(
        deviceToken: String,
        pinnedCertSha256: String?,
        endpoints: EndpointCandidates,
        preferredTarget: String? = nil,
        preferredChannel: NativeChannel? = nil
    ) {
        self.deviceToken = deviceToken
        self.pinnedCertSha256 = pinnedCertSha256
        self.endpoints = endpoints
        self.preferredTarget = preferredTarget
        self.preferredChannel = preferredChannel
    }
}

public enum KeychainError: Error, LocalizedError, Equatable, Sendable {
    case encodingFailed
    case decodingFailed
    case osStatus(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .encodingFailed:
            return "凭据编码失败"
        case .decodingFailed:
            return "钥匙串凭据读取损坏，请重新配对"
        case .osStatus(let status):
            return "钥匙串访问失败（OSStatus: \(status)）"
        }
    }
}

/// Persistence abstraction enabling deterministic unit testing alongside production Keychain storage.
public protocol CredentialStore: AnyObject, Sendable {
    func load() throws -> StoredCredentials?
    func save(_ credentials: StoredCredentials) throws
    func clearAll() throws
}

/// Keychain-backed store using `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
/// so device tokens and pins are never synchronized to iCloud Backup or migrated across devices.
public final class KeychainStore: CredentialStore, @unchecked Sendable {
    private let service: String
    private let account: String
    private let lock = NSLock()

    public init(
        service: String = "dev.vecway.mobile.credentials",
        account: String = "default"
    ) {
        self.service = service
        self.account = account
    }

    public func load() throws -> StoredCredentials? {
        lock.lock()
        defer { lock.unlock() }

        var query = baseQuery()
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainError.osStatus(status)
        }
        guard let data = result as? Data else {
            throw KeychainError.decodingFailed
        }
        do {
            return try JSONDecoder().decode(StoredCredentials.self, from: data)
        } catch {
            throw KeychainError.decodingFailed
        }
    }

    public func save(_ credentials: StoredCredentials) throws {
        lock.lock()
        defer { lock.unlock() }

        let data: Data
        do {
            data = try JSONEncoder().encode(credentials)
        } catch {
            throw KeychainError.encodingFailed
        }

        let query = baseQuery()
        let attributesToUpdate: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributesToUpdate as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        if updateStatus == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.osStatus(addStatus)
            }
            return
        }
        throw KeychainError.osStatus(updateStatus)
    }

    public func clearAll() throws {
        lock.lock()
        defer { lock.unlock() }

        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.osStatus(status)
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

/// Thread-safe in-memory store for deterministic XCTest execution.
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: StoredCredentials?

    public init(initial: StoredCredentials? = nil) {
        self.stored = initial
    }

    public func load() throws -> StoredCredentials? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    public func save(_ credentials: StoredCredentials) throws {
        lock.lock()
        defer { lock.unlock() }
        stored = credentials
    }

    public func clearAll() throws {
        lock.lock()
        defer { lock.unlock() }
        stored = nil
    }
}
