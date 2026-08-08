import Foundation

/// The two API calls the share flow needs. The record creation happens
/// in the foreground (small and fast); the blob rides a background
/// URLSession that outlives the extension, which is the entire reason
/// networking lives in Swift rather than Rust.
enum EngramApi {
    static let uploadSessionIdentifier = "com.harsharahul.engramstore.share.upload"

    struct CreatedFile: Decodable { let id: String }

    /// POST /api/files with the sealed key and metadata; returns the id.
    static func createFile(
        record: HandoffRecord,
        encryptedKeyJSON: String,
        encryptedMetaJSON: String,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        guard let url = URL(string: "\(record.origin)/api/files"),
              let key = try? JSONSerialization.jsonObject(with: Data(encryptedKeyJSON.utf8)),
              let meta = try? JSONSerialization.jsonObject(with: Data(encryptedMetaJSON.utf8)),
              let body = try? JSONSerialization.data(withJSONObject: [
                  "folderId": NSNull(),
                  "encryptedKey": key,
                  "encryptedMeta": meta,
              ])
        else {
            completion(.failure(ShareError.badEnvelope))
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(record.token)", forHTTPHeaderField: "authorization")
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let data, let created = try? JSONDecoder().decode(CreatedFile.self, from: data)
            else {
                completion(.failure(ShareError.serverRefused))
                return
            }
            completion(.success(created.id))
        }.resume()
    }

    /// The upload that survives the sheet closing: a background session
    /// bound to the app group container, one PUT per staged blob.
    static func backgroundSession() -> URLSession {
        let config = URLSessionConfiguration.background(withIdentifier: uploadSessionIdentifier)
        config.sharedContainerIdentifier = EngramHandoff.appGroup
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        return URLSession(configuration: config)
    }

    static func enqueueUpload(session: URLSession, record: HandoffRecord, fileId: String, blob: URL) {
        guard let url = URL(string: "\(record.origin)/api/files/\(fileId)/data") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(record.token)", forHTTPHeaderField: "authorization")
        session.uploadTask(with: request, fromFile: blob).resume()
    }
}

enum ShareError: LocalizedError {
    case notSignedIn
    case staleToken
    case badEnvelope
    case serverRefused
    case unreadableItem

    var errorDescription: String? {
        switch self {
        case .notSignedIn:
            return "Open Engram Store and turn on Extensions in your profile, then try again."
        case .staleToken:
            return "Open Engram Store once to sign in again, then try again."
        case .badEnvelope: return "Could not prepare the encrypted upload."
        case .serverRefused: return "The vault did not accept the file."
        case .unreadableItem: return "This item could not be read."
        }
    }
}
