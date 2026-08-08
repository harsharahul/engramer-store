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

enum EngramHandoff {
    static let service = "com.harsharahul.engramstore.handoff"
    static let accessGroup = "5MD7MFXN8S.com.harsharahul.engramstore"
    static let appGroup = "group.com.harsharahul.engramstore"

    /// The one record, whoever it belongs to: the account attribute is
    /// the email, unknown to the extension until it reads the item.
    static func read() -> HandoffRecord? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return try? JSONDecoder().decode(HandoffRecord.self, from: data)
    }
}
