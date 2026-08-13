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
        folderId: String? = nil,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        guard let url = URL(string: "\(record.origin)/api/files"),
              let key = try? JSONSerialization.jsonObject(with: Data(encryptedKeyJSON.utf8)),
              let meta = try? JSONSerialization.jsonObject(with: Data(encryptedMetaJSON.utf8)),
              let body = try? JSONSerialization.data(withJSONObject: [
                  "folderId": folderId ?? NSNull(),
                  "encryptedKey": key,
                  "encryptedMeta": meta,
              ] as [String: Any])
        else {
            completion(.failure(ShareError.badEnvelope))
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(record.token)", forHTTPHeaderField: "authorization")
        blockingSession.dataTask(with: request) { data, response, error in
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

// MARK: - Synchronous write surface for the File Provider.
// Provider callbacks run on background queues and expect the work done
// when the completion fires, so these block on a semaphore. Every block
// is bounded twice over: the session fails a request that goes twenty
// seconds without bytes and caps any transfer at an hour, and the wait
// itself has a ceiling in case no callback ever fires. An unbounded
// wait here wedges fileproviderd's whole domain; this project has
// already paid once for undeadlined network calls on automatic paths.

/// What a content upload came back as; the provider maps refusals to
/// conflict copies rather than data loss.
enum EngramUploadOutcome {
    case ok
    /// The server refused: a generation race or a live co-editing session.
    case conflict
    case failed(String)
}

extension EngramApi {
    /// The threshold above which content travels as numbered parts, so a
    /// network blip costs one part rather than the whole file.
    static let partsThreshold: UInt64 = 64 * 1024 * 1024
    private static let partSize: UInt64 = 8 * 1024 * 1024

    /// The session behind every blocking call: no bytes for twenty
    /// seconds fails the request (the accepted-then-silent connection
    /// only a timeout can catch), an hour caps any single transfer, and
    /// connectivity is never waited for; offline must answer now, as an
    /// error the provider can surface, not as a quiet hang.
    static let blockingSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 3600
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    /// Ceiling on the semaphore itself, above the session's own limits:
    /// if no callback ever fires, the wait still ends. On a lapse the
    /// result is not read, so the late callback races nothing.
    private static let waitCeiling: TimeInterval = 3660

    private static func request(
        _ record: HandoffRecord,
        _ method: String,
        _ path: String,
        body: Data? = nil,
        contentType: String? = nil
    ) -> URLRequest? {
        guard let url = URL(string: "\(record.origin)\(path)") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "content-type")
        }
        request.setValue("Bearer \(record.token)", forHTTPHeaderField: "authorization")
        return request
    }

    private static func send(_ request: URLRequest) -> (Int, Data)? {
        var result: (Int, Data)?
        let done = DispatchSemaphore(value: 0)
        blockingSession.dataTask(with: request) { data, response, _ in
            defer { done.signal() }
            guard let http = response as? HTTPURLResponse else { return }
            result = (http.statusCode, data ?? Data())
        }.resume()
        if done.wait(timeout: .now() + waitCeiling) == .timedOut {
            return nil
        }
        return result
    }

    private static func sendFile(_ request: URLRequest, from file: URL) -> (Int, Data)? {
        var result: (Int, Data)?
        let done = DispatchSemaphore(value: 0)
        blockingSession.uploadTask(with: request, fromFile: file) { data, response, _ in
            defer { done.signal() }
            guard let http = response as? HTTPURLResponse else { return }
            result = (http.statusCode, data ?? Data())
        }.resume()
        if done.wait(timeout: .now() + waitCeiling) == .timedOut {
            return nil
        }
        return result
    }

    /// JSON GET returning the body on 2xx.
    static func getJson(record: HandoffRecord, path: String) -> Data? {
        guard let request = request(record, "GET", path),
              let (status, data) = send(request), (200..<300).contains(status)
        else { return nil }
        return data
    }

    /// JSON POST/PATCH returning the decoded body on 2xx.
    static func json(
        record: HandoffRecord,
        method: String,
        path: String,
        payload: [String: Any]
    ) -> Data? {
        guard let body = try? JSONSerialization.data(withJSONObject: payload),
              let request = request(record, method, path, body: body, contentType: "application/json"),
              let (status, data) = send(request), (200..<300).contains(status)
        else { return nil }
        return data
    }

    /// Uploads a staged ciphertext blob as the file's content: one PUT
    /// below the threshold, the parts flow above it.
    static func uploadContent(record: HandoffRecord, fileId: String, blob: URL) -> EngramUploadOutcome {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: blob.path)[.size] as? NSNumber)?
            .uint64Value
        else { return .failed("staged blob unreadable") }
        if size < partsThreshold {
            guard let put = request(record, "PUT", "/api/files/\(fileId)/data", contentType: "application/octet-stream"),
                  let (status, _) = sendFile(put, from: blob)
            else { return .failed("upload did not complete") }
            if (200..<300).contains(status) { return .ok }
            return status == 409 ? .conflict : .failed("upload refused (\(status))")
        }
        return uploadParts(record: record, fileId: fileId, blob: blob, size: size)
    }

    private static func uploadParts(
        record: HandoffRecord, fileId: String, blob: URL, size: UInt64
    ) -> EngramUploadOutcome {
        struct Begun: Decodable { let session: String }
        guard let beginData = json(
            record: record, method: "POST", path: "/api/files/\(fileId)/data/parts",
            payload: ["size": size]
        ), let begun = try? JSONDecoder().decode(Begun.self, from: beginData)
        else { return .failed("could not begin a parts upload") }

        guard let handle = try? FileHandle(forReadingFrom: blob) else {
            return .failed("staged blob unreadable")
        }
        defer { try? handle.close() }
        var part = 1
        while true {
            let chunk = handle.readData(ofLength: Int(Self.partSize))
            if chunk.isEmpty { break }
            guard var putReq = request(
                record, "PUT", "/api/files/\(fileId)/data/parts/\(begun.session)/\(part)",
                contentType: "application/octet-stream"
            ) else { return .failed("bad part request") }
            putReq.httpBody = chunk
            guard let (status, _) = send(putReq), (200..<300).contains(status) else {
                _ = json(record: record, method: "DELETE",
                         path: "/api/files/\(fileId)/data/parts/\(begun.session)", payload: [:])
                return .failed("part \(part) refused")
            }
            part += 1
        }
        guard let completeReq = request(
            record, "POST", "/api/files/\(fileId)/data/parts/\(begun.session)/complete",
            body: Data("{}".utf8), contentType: "application/json"
        ), let (status, _) = send(completeReq) else { return .failed("completion did not answer") }
        if (200..<300).contains(status) { return .ok }
        return status == 409 ? .conflict : .failed("completion refused (\(status))")
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
