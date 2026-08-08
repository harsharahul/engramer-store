import Foundation
import Security

/// The account envelope the main app placed in the shared keychain when
/// the owner turned on "Extensions on this device". Extensions read it;
/// only the app writes it.
struct HandoffRecord: Decodable {
    let v: Int
    let email: String
    let origin: String
    let token: String
    let tokenIssuedAt: UInt64
    let masterKey: String
    let publicKey: String
    let createdAt: UInt64

    /// Base64url without padding, the encoding the whole product uses.
    var masterKeyBytes: Data? {
        var b64 = masterKey.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64.append("=") }
        return Data(base64Encoded: b64)
    }

    /// The 30-day token has no refresh endpoint; past this the extension
    /// asks the owner to open the app rather than failing opaquely.
    var tokenLooksStale: Bool {
        let age = Date().timeIntervalSince1970 * 1000 - Double(tokenIssuedAt)
        return age > 29 * 24 * 3600 * 1000
    }
}

/// Why a handoff read came back empty, precise enough to act on: a
/// missing item means the app never stored one (or the keychain was
/// cleared by a reinstall), a denial means this process could not use
/// the shared access group at all, and an unreadable record means bytes
/// arrived that this build cannot decode.
enum HandoffReadFailure: Error {
    case missing
    case denied(OSStatus)
    case unreadable

    /// A short suffix for user-facing messages, so a report from the
    /// device says which of the three happened.
    var detail: String {
        switch self {
        case .missing: return "no stored key"
        case .denied(let status): return "keychain error \(status)"
        case .unreadable: return "stored key unreadable"
        }
    }
}

enum EngramHandoff {
    static let service = "com.harsharahul.engramstore.handoff"
    static let accessGroup = "5MD7MFXN8S.com.harsharahul.engramstore"
    static let appGroup = "group.com.harsharahul.engramstore"

    /// The one record, whoever it belongs to: the account attribute is
    /// the email, unknown to the extension until it reads the item.
    static func read() -> HandoffRecord? {
        switch readDetailed() {
        case .success(let record): return record
        case .failure: return nil
        }
    }

    static func readDetailed() -> Result<HandoffRecord, HandoffReadFailure> {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else {
            return .failure(status == errSecItemNotFound ? .missing : .denied(status))
        }
        guard let data = result as? Data,
              let record = try? JSONDecoder().decode(HandoffRecord.self, from: data)
        else { return .failure(.unreadable) }
        return .success(record)
    }
}
