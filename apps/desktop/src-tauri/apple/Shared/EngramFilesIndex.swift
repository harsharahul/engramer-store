import Foundation
import os.log

/// Temporary diagnostic channel for the missing-rows hunt; read with
/// `log show --predicate 'subsystem == "com.harsharahul.engramstore.files"'`.
let indexLog = Logger(subsystem: "com.harsharahul.engramstore.files", category: "index")

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
    private var entries: [String: IndexEntry] = [:]
    private var cursor: Int = 0
    private let record: HandoffRecord
    private let master: Data
    // Enumerations read while refreshes write, from whatever queues the
    // provider host uses; one lock guards the state, and the network is
    // never dialed while holding it.
    private let stateLock = NSLock()
    // Refreshes serialize among themselves, and the background variant
    // is single-flight with a staleness gate so a burst of folder opens
    // costs one delta pull, not one per window.
    private let refreshGate = NSLock()
    private let backgroundQueue = DispatchQueue(label: "com.harsharahul.engramstore.index-refresh")
    private var backgroundInFlight = false
    private var lastRefreshEnd = Date.distantPast

    init?(record: HandoffRecord) {
        guard let master = record.masterKeyBytes, master.count == 32 else { return nil }
        self.record = record
        self.master = master
        load()
    }

    private static var indexURL: URL? {
        // The app group container when it exists (iOS); the extension's
        // own container otherwise (macOS ships no app group, and losing
        // persistence silently meant a full re-sync on every process).
        if let group = EngramOutbox.container {
            return group.appendingPathComponent("files-index.json")
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("files-index.json")
    }

    private struct Persisted: Codable {
        let cursor: Int
        let entries: [IndexEntry]
        /// The server this index was pulled from. The file's name is
        /// fixed, so it survives a server switch; the cursor and
        /// entries must not. Optional because files written before the
        /// field existed carry none, which reads as a mismatch.
        let origin: String?
    }

    private func load() {
        guard let url = Self.indexURL,
              let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode(Persisted.self, from: data)
        else { return }
        // Another server's index is worse than none: its cursor points
        // into a different sequence space and its entries name files
        // this server has never heard of. Start fresh instead.
        guard stored.origin == record.origin else {
            Self.wipe()
            return
        }
        cursor = stored.cursor
        entries = Dictionary(uniqueKeysWithValues: stored.entries.map { ($0.id, $0) })
    }

    private static var saveOutcomeLogged = false

    private func save() {
        guard let url = Self.indexURL,
              let data = try? JSONEncoder().encode(
                  Persisted(cursor: cursor, entries: Array(entries.values), origin: record.origin))
        else { return }
        // File protection classes are an iOS concept; asking for one on
        // macOS is how this write failed silently for a whole day.
        #if os(macOS)
            let options: Data.WritingOptions = [.atomic]
        #else
            let options: Data.WritingOptions = [.atomic, .completeFileProtection]
        #endif
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: options)
            if !Self.saveOutcomeLogged {
                Self.saveOutcomeLogged = true
                indexLog.info("index persisted at \(url.path, privacy: .public)")
            }
        } catch {
            if !Self.saveOutcomeLogged {
                Self.saveOutcomeLogged = true
                indexLog.error("index save failed at \(url.path, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
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
        refreshGate.lock()
        defer { refreshGate.unlock() }
        var changed: [String] = []
        var hops = 0
        while hops < 200 {
            hops += 1
            let since = withState { self.cursor }
            guard let page = fetchPage(since: since, limit: pageLimit) else {
                indexLog.error("refresh: page fetch failed at cursor \(since, privacy: .public)")
                break
            }
            indexLog.info("refresh: page seq=\(page.seq, privacy: .public) folders=\(page.folders.count, privacy: .public) files=\(page.files.count, privacy: .public) cursor=\(since, privacy: .public)")
            let done: Bool = withState {
                for folder in page.folders {
                    changed.append(folder.id)
                    self.apply(folder: folder)
                }
                for file in page.files {
                    changed.append(file.id)
                    self.apply(file: file)
                }
                if page.seq <= self.cursor { return true }
                self.cursor = page.seq
                return page.folders.isEmpty && page.files.isEmpty
            }
            if done { break }
        }
        withState {
            self.dedupeNames()
            self.save()
            self.lastRefreshEnd = Date()
        }
        return changed
    }

    /// The off-the-hot-path variant: an enumeration serves what it has
    /// and asks for freshness here; one flight at a time, and a recent
    /// refresh answers immediately with nothing.
    func refreshSoon(staleness: TimeInterval = 15, onChange: @escaping ([String]) -> Void) {
        let skip: Bool = withState {
            if self.backgroundInFlight || Date().timeIntervalSince(self.lastRefreshEnd) < staleness {
                return true
            }
            self.backgroundInFlight = true
            return false
        }
        if skip { return }
        backgroundQueue.async {
            let changed = self.refresh()
            self.withState { self.backgroundInFlight = false }
            if !changed.isEmpty {
                onChange(changed)
            }
        }
    }

    private func withState<T>(_ body: () -> T) -> T {
        stateLock.lock()
        defer { stateLock.unlock() }
        return body()
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
        guard let key = openKey(file.encryptedKey) else {
            indexLog.error("apply: key refused for file \(String(file.id.prefix(8)), privacy: .public)")
            return
        }
        guard let meta = openMeta(file.encryptedMeta, key: key) else {
            indexLog.error("apply: meta refused for file \(String(file.id.prefix(8)), privacy: .public)")
            return
        }
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
        withState { entries.values.filter { $0.parentId == parent }.sorted { $0.id < $1.id } }
    }

    func entry(_ id: String) -> IndexEntry? {
        withState { entries[id] }
    }

    func entriesSnapshot() -> [IndexEntry] {
        withState { Array(entries.values) }
    }

    var isEmpty: Bool {
        withState { entries.isEmpty }
    }

    var syncCursor: Int {
        withState { cursor }
    }
}
