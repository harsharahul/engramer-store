import Foundation

/// The decrypted listing the provider enumerates: ids, names, tree shape,
/// per-file keys. Built by pulling the sync feed in pages and opening
/// each row's key and metadata through the Rust core; persisted in the
/// app group so a fresh provider process starts from its cursor rather
/// than from zero.
///
/// This is decrypted material at rest, accepted deliberately: the file
/// carries complete file protection until first unlock, lives in the app
/// group, and is removed when the handoff is turned off or the account
/// signs out. The master key protecting everything else sits in the same
/// keychain either way; storing ciphertext here and decrypting per
/// enumeration would spend battery to remove nothing.
struct IndexEntry: Codable {
    let id: String
    let parentId: String?
    let isFolder: Bool
    var displayName: String
    let mime: String?
    let plainSize: UInt64?
    let mtimeMs: UInt64?
    let generation: Int?
    let updateSeq: Int
    /// The object's own key, so materialization never re-opens the
    /// wrapped key JSON.
    let key: Data
    let digest: String?
    let trashed: Bool
    /// The sealed metadata exactly as the server holds it. A rename
    /// decrypts THIS, edits one field, and reseals, so fields this index
    /// does not model (tags, facts, thumbnails) survive untouched.
    var encryptedMetaJson: String = ""
}

struct SyncFolderRow: Decodable {
    let id: String
    let parentId: String?
    let encryptedKey: EncryptedBlob?
    let encryptedMeta: EncryptedBlob?
    let deleted: Bool
    let updateSeq: Int
}

struct SyncFileRow: Decodable {
    let id: String
    let folderId: String?
    let encryptedKey: EncryptedBlob?
    let encryptedMeta: EncryptedBlob?
    let generation: Int?
    let trashed: Bool
    let deleted: Bool
    let uploaded: Bool
    let updateSeq: Int
}

struct EncryptedBlob: Codable {
    let ciphertext: String
    let nonce: String
    var json: String {
        (try? String(data: JSONEncoder().encode(self), encoding: .utf8)) ?? "{}"
    }
}

struct SyncPage: Decodable {
    let seq: Int
    let folders: [SyncFolderRow]
    let files: [SyncFileRow]
}

final class EngramFilesIndex {
    private(set) var entries: [String: IndexEntry] = [:]
    private(set) var cursor: Int = 0
    private let record: HandoffRecord
    private let master: Data

    init?(record: HandoffRecord) {
        guard let master = record.masterKeyBytes, master.count == 32 else { return nil }
        self.record = record
        self.master = master
        load()
    }

    private static var indexURL: URL? {
        EngramOutbox.container?.appendingPathComponent("files-index.json")
    }

    private struct Persisted: Codable {
        let cursor: Int
        let entries: [IndexEntry]
    }

    private func load() {
        guard let url = Self.indexURL,
              let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode(Persisted.self, from: data)
        else { return }
        cursor = stored.cursor
        entries = Dictionary(uniqueKeysWithValues: stored.entries.map { ($0.id, $0) })
    }

    private func save() {
        guard let url = Self.indexURL,
              let data = try? JSONEncoder().encode(Persisted(cursor: cursor, entries: Array(entries.values)))
        else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtection])
    }

    static func wipe() {
        if let url = indexURL {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// Pulls every sync page past the cursor, decrypting as it goes.
    /// Returns the ids that changed. Synchronous by design: providers are
    /// called on background queues and expect the work done when the
    /// completion runs.
    @discardableResult
    func refresh(pageLimit: Int = 500) -> [String] {
        var changed: [String] = []
        var hops = 0
        while hops < 200 {
            hops += 1
            guard let page = fetchPage(since: cursor, limit: pageLimit) else { break }
            for folder in page.folders {
                changed.append(folder.id)
                apply(folder: folder)
            }
            for file in page.files {
                changed.append(file.id)
                apply(file: file)
            }
            if page.seq <= cursor { break }
            cursor = page.seq
            if page.folders.isEmpty && page.files.isEmpty { break }
        }
        dedupeNames()
        save()
        return changed
    }

    private func fetchPage(since: Int, limit: Int) -> SyncPage? {
        guard let url = URL(string: "\(record.origin)/api/sync?since=\(since)&limit=\(limit)") else {
            return nil
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(record.token)", forHTTPHeaderField: "authorization")
        var result: SyncPage?
        let done = DispatchSemaphore(value: 0)
        // The deadlined session, plus a tight ceiling of its own: an
        // enumeration blocks a Finder listing, and two minutes without a
        // page is a failed refresh to retry, not a reason to hold the
        // window. A lapse leaves result unread, so the late callback
        // races nothing.
        EngramApi.blockingSession.dataTask(with: request) { data, response, _ in
            defer { done.signal() }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data else { return }
            result = try? JSONDecoder().decode(SyncPage.self, from: data)
        }.resume()
        if done.wait(timeout: .now() + 120) == .timedOut {
            return nil
        }
        return result
    }

    private func apply(folder: SyncFolderRow) {
        if folder.deleted {
            entries.removeValue(forKey: folder.id)
            return
        }
        guard let key = openKey(folder.encryptedKey),
              let meta = openMeta(folder.encryptedMeta, key: key)
        else { return }
        entries[folder.id] = IndexEntry(
            id: folder.id,
            parentId: folder.parentId,
            isFolder: true,
            displayName: sanitize(meta["name"] as? String ?? "Folder"),
            mime: nil,
            plainSize: nil,
            mtimeMs: nil,
            generation: nil,
            updateSeq: folder.updateSeq,
            key: key,
            digest: nil,
            trashed: false,
            encryptedMetaJson: folder.encryptedMeta?.json ?? ""
        )
    }

    private func apply(file: SyncFileRow) {
        // Tombstones, trash, and never-uploaded shells stay out of Files.
        if file.deleted || file.trashed || !file.uploaded {
            entries.removeValue(forKey: file.id)
            return
        }
        guard let key = openKey(file.encryptedKey),
              let meta = openMeta(file.encryptedMeta, key: key)
        else { return }
        entries[file.id] = IndexEntry(
            id: file.id,
            parentId: file.folderId,
            isFolder: false,
            displayName: sanitize(meta["name"] as? String ?? file.id),
            mime: meta["mime"] as? String,
            plainSize: (meta["size"] as? NSNumber)?.uint64Value,
            mtimeMs: (meta["mtime"] as? NSNumber)?.uint64Value,
            generation: file.generation,
            updateSeq: file.updateSeq,
            key: key,
            digest: meta["digest"] as? String,
            trashed: false,
            encryptedMetaJson: file.encryptedMeta?.json ?? ""
        )
    }

    private func openKey(_ blob: EncryptedBlob?) -> Data? {
        guard let blob else { return nil }
        return try? openFileKey(encryptedKeyJson: blob.json, masterKey: master)
    }

    private func openMeta(_ blob: EncryptedBlob?, key: Data) -> [String: Any]? {
        guard let blob,
              let json = try? decryptMetadataJson(encryptedMetaJson: blob.json, objectKey: key),
              let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8))
        else { return nil }
        return parsed as? [String: Any]
    }

    /// Files forbids path separators and duplicate names within a parent.
    private func sanitize(_ name: String) -> String {
        let cleaned = name
            .replacingOccurrences(of: "/", with: ":")
            .replacingOccurrences(of: "\0", with: "")
        return cleaned.isEmpty ? "Untitled" : cleaned
    }

    private func dedupeNames() {
        var seen: [String: Int] = [:]
        for id in entries.keys.sorted() {
            guard var entry = entries[id] else { continue }
            let slot = "\(entry.parentId ?? "root")/\(entry.displayName.lowercased())"
            let count = seen[slot, default: 0]
            seen[slot] = count + 1
            if count > 0 {
                let base = (entry.displayName as NSString).deletingPathExtension
                let ext = (entry.displayName as NSString).pathExtension
                entry.displayName = ext.isEmpty ? "\(base) (\(count + 1))" : "\(base) (\(count + 1)).\(ext)"
                entries[id] = entry
            }
        }
    }

    func children(of parent: String?) -> [IndexEntry] {
        entries.values.filter { $0.parentId == parent }.sorted { $0.id < $1.id }
    }

    func entry(_ id: String) -> IndexEntry? {
        entries[id]
    }
}
