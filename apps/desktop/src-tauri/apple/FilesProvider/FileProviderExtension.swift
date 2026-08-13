import FileProvider
import UniformTypeIdentifiers

/// The vault in the Files app, read-only: browse, open, copy out. Every
/// byte leaves this process decrypted only after its digest matched the
/// one sealed inside the metadata. Writes arrive in the next iteration
/// with their conflict handling designed in; refusing them here is what
/// keeps the first shipped provider trustworthy.
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    private var index: EngramFilesIndex?
    private var record: HandoffRecord?
    private let reconnectLock = NSLock()
    private let domain: NSFileProviderDomain

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        super.init()
        reconnectIfNeeded()
    }

    /// A fetch that exhausted its retries: remember it (the version salt
    /// makes the item look changed) and ask the system to re-enumerate,
    /// so the replica that just dropped the placeholder reconciles it
    /// back instead of hiding the file until the next re-registration.
    private func noteFailedFetch(_ entry: IndexEntry) {
        FetchFailures.shared.bump(entry.id)
        guard let manager = NSFileProviderManager(for: domain) else { return }
        let containers: [NSFileProviderItemIdentifier] = [
            .workingSet,
            entry.parentId.map(NSFileProviderItemIdentifier.init(rawValue:)) ?? .rootContainer,
        ]
        for container in containers {
            manager.signalEnumerator(for: container) { _ in }
        }
    }

    /// This instance can outlive an "open the app to connect" round trip:
    /// the app writes the handoff after the system already spawned the
    /// provider. A missing record is therefore re-read on every call
    /// instead of being cached as a permanent "not signed in".
    private func reconnectIfNeeded() {
        reconnectLock.lock()
        defer { reconnectLock.unlock() }
        guard index == nil else { return }
        record = EngramHandoff.read()
        index = record.flatMap(EngramFilesIndex.init)
    }

    func invalidate() {}

    /// The set of locally-materialized items changed; that includes the
    /// aftermath of downloads the system failed and cleaned up without
    /// consulting this process. Owe the replica a reconcile.
    func materializedItemsDidChange(completionHandler: @escaping () -> Void) {
        ReconcileState.shared.request()
        if let manager = NSFileProviderManager(for: domain) {
            manager.signalEnumerator(for: .workingSet) { _ in }
        }
        completionHandler()
    }

    func item(
        for identifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        reconnectIfNeeded()
        if identifier == .rootContainer {
            completionHandler(RootItem(), nil)
            return Progress()
        }
        guard let entry = index?.entry(identifier.rawValue) else {
            completionHandler(nil, NSFileProviderError(.noSuchItem))
            return Progress()
        }
        completionHandler(EngramFilesItem(entry), nil)
        return Progress()
    }

    /// One session for content downloads: no shared cache (the blob lands
    /// on disk once, in the download file itself), a modest per-request
    /// timeout, and a generous ceiling for large files.
    private static let contentSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 600
        return URLSession(configuration: config)
    }()

    func fetchContents(
        for itemIdentifier: NSFileProviderItemIdentifier,
        version requestedVersion: NSFileProviderItemVersion?,
        request: NSFileProviderRequest,
        completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        reconnectIfNeeded()
        let progress = Progress(totalUnitCount: 100)
        guard let record, let entry = index?.entry(itemIdentifier.rawValue), !entry.isFolder else {
            completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
            return progress
        }
        guard let url = URL(string: "\(record.origin)/api/files/\(entry.id)/data") else {
            completionHandler(nil, nil, NSFileProviderError(.serverUnreachable))
            return progress
        }
        var download = URLRequest(url: url)
        download.setValue("Bearer \(record.token)", forHTTPHeaderField: "authorization")
        downloadAndDecrypt(download, entry: entry, attempt: 1, progress: progress,
                           completionHandler: completionHandler)
        return progress
    }

    /// Download to disk, then stream-decrypt file to file: peak memory
    /// stays near one 4 MiB chunk regardless of file size, which is what
    /// keeps this process alive under the extension memory cap (the
    /// in-memory path was how "couldn't communicate with a helper
    /// application" happened on large files). One retry absorbs the cold
    /// first request after the process or the network slept.
    private func downloadAndDecrypt(
        _ request: URLRequest, entry: IndexEntry, attempt: Int, progress: Progress,
        completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
    ) {
        let task = Self.contentSession.downloadTask(with: request) { downloaded, response, error in
            if error != nil {
                if attempt == 1, !progress.isCancelled {
                    self.downloadAndDecrypt(request, entry: entry, attempt: 2, progress: progress,
                                            completionHandler: completionHandler)
                } else {
                    self.noteFailedFetch(entry)
                    completionHandler(nil, nil, NSFileProviderError(.serverUnreachable))
                }
                return
            }
            guard let http = response as? HTTPURLResponse else {
                self.noteFailedFetch(entry)
                completionHandler(nil, nil, NSFileProviderError(.serverUnreachable))
                return
            }
            if http.statusCode == 401 {
                completionHandler(nil, nil, NSFileProviderError(.notAuthenticated))
                return
            }
            guard http.statusCode == 200, let downloaded else {
                if http.statusCode != 404 {
                    self.noteFailedFetch(entry)
                }
                completionHandler(nil, nil, NSFileProviderError(
                    http.statusCode == 404 ? .noSuchItem : .serverUnreachable))
                return
            }
            // The system deletes the downloaded file when this block
            // returns; move it out synchronously before decrypting.
            let blob = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
            let staged = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
            do {
                try FileManager.default.moveItem(at: downloaded, to: blob)
            } catch {
                completionHandler(nil, nil, NSFileProviderError(.serverUnreachable))
                return
            }
            defer { try? FileManager.default.removeItem(at: blob) }
            do {
                // The digest sealed in the metadata is the end-to-end
                // truth, verified in the same streaming pass; a mismatch
                // deletes the output, and wrong bytes are never handed to
                // another app.
                _ = try decryptFileContents(
                    inputPath: blob.path, outputPath: staged.path,
                    fileKey: entry.key, expectedDigest: entry.digest
                )
            } catch {
                completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
                return
            }
            progress.completedUnitCount = progress.totalUnitCount
            completionHandler(staged, EngramFilesItem(entry), nil)
        }
        if attempt == 1 {
            // Files shows a real pie for the download, the long part.
            progress.addChild(task.progress, withPendingUnitCount: 95)
        }
        progress.cancellationHandler = { task.cancel() }
        task.resume()
    }

    // MARK: - Writes.
    // The rule every path below honors: no edit is ever lost, and stale
    // bytes never overwrite newer ones. A save whose base the server has
    // moved past becomes a visible conflict copy instead.

    private func parentFolderId(_ identifier: NSFileProviderItemIdentifier) -> String? {
        identifier == .rootContainer ? nil : identifier.rawValue
    }

    func createItem(
        basedOn itemTemplate: NSFileProviderItem,
        fields: NSFileProviderItemFields,
        contents url: URL?,
        options: NSFileProviderCreateItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        reconnectIfNeeded()
        let progress = Progress(totalUnitCount: 1)
        guard let record, let index, let master = record.masterKeyBytes else {
            completionHandler(nil, [], false, NSFileProviderError(.notAuthenticated))
            return progress
        }
        DispatchQueue.global(qos: .userInitiated).async {
            defer { progress.completedUnitCount = 1 }
            let parent = self.parentFolderId(itemTemplate.parentItemIdentifier)
            if itemTemplate.contentType == .folder {
                self.createFolder(named: itemTemplate.filename, in: parent, record: record,
                                  master: master, index: index, completionHandler: completionHandler)
            } else {
                self.createFile(from: itemTemplate, contents: url, in: parent, record: record,
                                master: master, index: index, completionHandler: completionHandler)
            }
        }
        return progress
    }

    private func createFolder(
        named name: String, in parent: String?, record: HandoffRecord, master: Data,
        index: EngramFilesIndex,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) {
        guard let envelope = try? folderEnvelope(name: name, masterKey: master),
              let key = try? JSONSerialization.jsonObject(with: Data(envelope.encryptedKeyJson.utf8)),
              let meta = try? JSONSerialization.jsonObject(with: Data(envelope.encryptedMetaJson.utf8)),
              let created = EngramApi.json(record: record, method: "POST", path: "/api/folders", payload: [
                  "parentId": parent ?? NSNull(),
                  "encryptedKey": key,
                  "encryptedMeta": meta,
              ]),
              let dto = try? JSONSerialization.jsonObject(with: created) as? [String: Any],
              let folderId = dto["id"] as? String
        else {
            completionHandler(nil, [], false, NSFileProviderError(.serverUnreachable))
            return
        }
        index.refresh()
        guard let entry = index.entry(folderId) else {
            completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
            return
        }
        completionHandler(EngramFilesItem(entry), [], false, nil)
    }

    private func createFile(
        from template: NSFileProviderItem, contents url: URL?, in parent: String?,
        record: HandoffRecord, master: Data, index: EngramFilesIndex,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) {
        guard let url else {
            // A dataless placeholder (fields without bytes) is not worth a
            // vault row; ask the system to send contents.
            completionHandler(nil, [], false, CocoaError(.featureUnsupported))
            return
        }
        // The protocol property is doubly optional: unset, or set to nil.
        let modified = (template.contentModificationDate ?? nil) ?? Date()
        let mtime = UInt64(modified.timeIntervalSince1970 * 1000)
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: scratch) }
        guard let envelope = try? encryptForUpload(
            inputPath: url.path,
            outputPath: scratch.path,
            masterKey: master,
            name: template.filename,
            mime: Self.mime(for: template),
            mtimeMs: mtime,
            sourceId: nil
        ),
            let key = try? JSONSerialization.jsonObject(with: Data(envelope.encryptedKeyJson.utf8)),
            let meta = try? JSONSerialization.jsonObject(with: Data(envelope.encryptedMetaJson.utf8)),
            let created = EngramApi.json(record: record, method: "POST", path: "/api/files", payload: [
                "folderId": parent ?? NSNull(),
                "encryptedKey": key,
                "encryptedMeta": meta,
            ]),
            let dto = try? JSONSerialization.jsonObject(with: created) as? [String: Any],
            let fileId = dto["id"] as? String
        else {
            completionHandler(nil, [], false, NSFileProviderError(.serverUnreachable))
            return
        }
        switch EngramApi.uploadContent(record: record, fileId: fileId, blob: scratch) {
        case .ok:
            break
        case .conflict, .failed:
            // The record exists without content; the index skips
            // not-uploaded rows, and a later save retries cleanly.
            completionHandler(nil, [], false, NSFileProviderError(.serverUnreachable))
            return
        }
        index.refresh()
        guard let entry = index.entry(fileId) else {
            completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
            return
        }
        completionHandler(EngramFilesItem(entry), [], false, nil)
    }

    func modifyItem(
        _ item: NSFileProviderItem,
        baseVersion version: NSFileProviderItemVersion,
        changedFields: NSFileProviderItemFields,
        contents newContents: URL?,
        options: NSFileProviderModifyItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        reconnectIfNeeded()
        let progress = Progress(totalUnitCount: 1)
        guard let record, let index, let master = record.masterKeyBytes else {
            completionHandler(nil, [], false, NSFileProviderError(.notAuthenticated))
            return progress
        }
        DispatchQueue.global(qos: .userInitiated).async {
            defer { progress.completedUnitCount = 1 }
            index.refresh()
            guard var entry = index.entry(item.itemIdentifier.rawValue) else {
                completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
                return
            }

            if changedFields.contains(.contents), let newContents {
                // The staleness check: the base Files saved from must still
                // be the server's current generation. The server's own 409
                // only catches a race DURING the upload; a base the web
                // moved past days ago would commit silently without this.
                let baseGeneration = String(data: version.contentVersion, encoding: .utf8)
                let current = "\(entry.generation ?? 0)"
                if let baseGeneration, baseGeneration != current {
                    self.surfaceConflictCopy(of: entry, contents: newContents, record: record,
                                             master: master, index: index,
                                             completionHandler: completionHandler)
                    return
                }
                switch self.uploadReplacement(entry: entry, contents: newContents,
                                              record: record, master: master) {
                case .ok:
                    break
                case .conflict:
                    self.surfaceConflictCopy(of: entry, contents: newContents, record: record,
                                             master: master, index: index,
                                             completionHandler: completionHandler)
                    return
                case .failed:
                    completionHandler(nil, [], false, NSFileProviderError(.serverUnreachable))
                    return
                }
                index.refresh()
                guard let fresh = index.entry(entry.id) else {
                    completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
                    return
                }
                entry = fresh
            }

            if changedFields.contains(.filename) || changedFields.contains(.parentItemIdentifier) {
                var payload: [String: Any] = [:]
                if changedFields.contains(.parentItemIdentifier) {
                    payload["folderId"] = self.parentFolderId(item.parentItemIdentifier) ?? NSNull()
                }
                if changedFields.contains(.filename) {
                    guard let sealed = self.resealMetadata(entry: entry, newName: item.filename) else {
                        completionHandler(nil, [], false, NSFileProviderError(.serverUnreachable))
                        return
                    }
                    payload["encryptedMeta"] = sealed
                }
                guard EngramApi.json(record: record, method: "PATCH",
                                     path: "/api/files/\(entry.id)", payload: payload) != nil
                else {
                    completionHandler(nil, [], false, NSFileProviderError(.serverUnreachable))
                    return
                }
                index.refresh()
            }

            guard let final = index.entry(entry.id) else {
                completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
                return
            }
            completionHandler(EngramFilesItem(final), [], false, nil)
        }
        return progress
    }

    /// Encrypts the replacement bytes under the file's existing key and
    /// uploads them, then reseals the metadata with the new digest, size
    /// and mtime. Content first: a failed upload leaves the old
    /// generation serving and the metadata untouched.
    private func uploadReplacement(
        entry: IndexEntry, contents: URL, record: HandoffRecord, master: Data
    ) -> EngramUploadOutcome {
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: scratch) }
        // Reuse the existing file key by sealing manually: metadata JSON is
        // decrypted, updated, resealed; content streams through the
        // format file to file under the same key, so a multi-gigabyte
        // save from another app costs one chunk of memory, not the file.
        guard let metaJson = try? decryptMetadataJson(
            encryptedMetaJson: entry.encryptedMetaJson, objectKey: entry.key
        ), var meta = (try? JSONSerialization.jsonObject(with: Data(metaJson.utf8))) as? [String: Any]
        else { return .failed("metadata unreadable") }

        let envelope: ReplacementEnvelope
        do {
            envelope = try encryptFileReplacement(
                inputPath: contents.path, outputPath: scratch.path, fileKey: entry.key
            )
        } catch {
            return .failed("encryption failed")
        }

        let outcome = EngramApi.uploadContent(record: record, fileId: entry.id, blob: scratch)
        guard case .ok = outcome else { return outcome }

        meta["digest"] = envelope.digest
        meta["size"] = envelope.plainSize
        meta["mtime"] = UInt64(Date().timeIntervalSince1970 * 1000)
        if let updated = try? JSONSerialization.data(withJSONObject: meta),
           let updatedJson = String(data: updated, encoding: .utf8),
           let sealed = try? encryptMetadataJson(metaJson: updatedJson, objectKey: entry.key),
           let sealedObject = try? JSONSerialization.jsonObject(with: Data(sealed.utf8)) {
            _ = EngramApi.json(record: record, method: "PATCH",
                               path: "/api/files/\(entry.id)",
                               payload: ["encryptedMeta": sealedObject])
        }
        return .ok
    }

    /// The no-edit-is-ever-lost path: the local bytes become a sibling
    /// "name (conflicted copy)" file; the winner keeps its place.
    private func surfaceConflictCopy(
        of entry: IndexEntry, contents: URL, record: HandoffRecord, master: Data,
        index: EngramFilesIndex,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) {
        let base = (entry.displayName as NSString).deletingPathExtension
        let ext = (entry.displayName as NSString).pathExtension
        let name = ext.isEmpty
            ? "\(base) (conflicted copy)"
            : "\(base) (conflicted copy).\(ext)"
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: scratch) }
        guard let envelope = try? encryptForUpload(
            inputPath: contents.path,
            outputPath: scratch.path,
            masterKey: master,
            name: name,
            mime: entry.mime ?? "application/octet-stream",
            mtimeMs: UInt64(Date().timeIntervalSince1970 * 1000),
            sourceId: nil
        ),
            let key = try? JSONSerialization.jsonObject(with: Data(envelope.encryptedKeyJson.utf8)),
            let meta = try? JSONSerialization.jsonObject(with: Data(envelope.encryptedMetaJson.utf8)),
            let created = EngramApi.json(record: record, method: "POST", path: "/api/files", payload: [
                "folderId": entry.parentId ?? NSNull(),
                "encryptedKey": key,
                "encryptedMeta": meta,
            ]),
            let dto = try? JSONSerialization.jsonObject(with: created) as? [String: Any],
            let copyId = dto["id"] as? String,
            case .ok = EngramApi.uploadContent(record: record, fileId: copyId, blob: scratch)
        else {
            // The copy could not be stored; refuse the save outright so
            // Files keeps the local bytes dirty and retries. Losing the
            // edit silently is the one outcome this path must never have.
            completionHandler(nil, [], false, NSFileProviderError(.serverUnreachable))
            return
        }
        index.refresh()
        // The item Files asked to modify resolves to the server's winner;
        // the local bytes live on as the copy beside it.
        guard let winner = index.entry(entry.id) else {
            completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
            return
        }
        completionHandler(EngramFilesItem(winner), [], false, nil)
    }

    private func resealMetadata(entry: IndexEntry, newName: String) -> Any? {
        guard let metaJson = try? decryptMetadataJson(
            encryptedMetaJson: entry.encryptedMetaJson, objectKey: entry.key
        ), var meta = (try? JSONSerialization.jsonObject(with: Data(metaJson.utf8))) as? [String: Any]
        else { return nil }
        meta["name"] = newName
        guard let updated = try? JSONSerialization.data(withJSONObject: meta),
              let updatedJson = String(data: updated, encoding: .utf8),
              let sealed = try? encryptMetadataJson(metaJson: updatedJson, objectKey: entry.key),
              let sealedObject = try? JSONSerialization.jsonObject(with: Data(sealed.utf8))
        else { return nil }
        return sealedObject
    }

    private static func mime(for item: NSFileProviderItem) -> String {
        item.contentType?.preferredMIMEType ?? "application/octet-stream"
    }

    func deleteItem(
        identifier: NSFileProviderItemIdentifier,
        baseVersion version: NSFileProviderItemVersion,
        options: NSFileProviderDeleteItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (Error?) -> Void
    ) -> Progress {
        reconnectIfNeeded()
        let progress = Progress(totalUnitCount: 1)
        guard let record, let index else {
            completionHandler(NSFileProviderError(.notAuthenticated))
            return progress
        }
        DispatchQueue.global(qos: .userInitiated).async {
            defer { progress.completedUnitCount = 1 }
            guard let entry = index.entry(identifier.rawValue), !entry.isFolder else {
                // Folder deletion cascades server-side trash over contents;
                // deferred until that UX is thought through. Files only.
                completionHandler(CocoaError(.featureUnsupported))
                return
            }
            // Server-side trash: restorable from the web app's Trash, so a
            // slip in Files is never a permanent loss.
            guard EngramApi.json(record: record, method: "DELETE",
                                 path: "/api/files/\(entry.id)", payload: [:]) != nil else {
                completionHandler(NSFileProviderError(.serverUnreachable))
                return
            }
            index.refresh()
            completionHandler(nil)
        }
        return progress
    }

    func enumerator(
        for containerItemIdentifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest
    ) throws -> NSFileProviderEnumerator {
        reconnectIfNeeded()
        guard let index else {
            throw NSFileProviderError(.notAuthenticated)
        }
        let domain = self.domain
        return EngramFilesEnumerator(index: index, container: containerItemIdentifier) {
            // Fresh rows landed after a listing already answered; the
            // change path delivers them within this signal's round trip.
            NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet) { _ in }
        }
    }
}

/// The domain root; everything else comes from the index.
final class RootItem: NSObject, NSFileProviderItem {
    var itemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var filename: String { "Engram Store" }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities {
        [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems]
    }
    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: Data("root".utf8), metadataVersion: Data("root".utf8))
    }
}

#if os(macOS)
    import AppKit

    /// The Finder context-menu action: one click puts a working share
    /// link on the clipboard, the same link the web app's Share dialog
    /// copies. An existing open, unlimited, unexpiring share is reused;
    /// only its absence mints a new one, so repeated clicks do not
    /// multiply tokens. The file key travels in the URL fragment, which
    /// browsers never send to the server.
    extension FileProviderExtension: NSFileProviderCustomAction {
        func performAction(
            identifier actionIdentifier: NSFileProviderExtensionActionIdentifier,
            onItemsWithIdentifiers itemIdentifiers: [NSFileProviderItemIdentifier],
            completionHandler: @escaping (Error?) -> Void
        ) -> Progress {
            let progress = Progress(totalUnitCount: 1)
            reconnectIfNeeded()
            guard actionIdentifier.rawValue == "com.harsharahul.engramstore.files.copylink",
                  let record, let index
            else {
                completionHandler(NSFileProviderError(.noSuchItem))
                return progress
            }
            let entries = itemIdentifiers.compactMap { index.entry($0.rawValue) }
                .filter { !$0.isFolder }
            guard !entries.isEmpty else {
                completionHandler(NSFileProviderError(.noSuchItem))
                return progress
            }
            DispatchQueue.global(qos: .userInitiated).async {
                defer { progress.completedUnitCount = 1 }
                let links = entries.compactMap { Self.shareLink(record: record, entry: $0) }
                guard links.count == entries.count else {
                    completionHandler(NSFileProviderError(.serverUnreachable))
                    return
                }
                DispatchQueue.main.async {
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setString(links.joined(separator: "\n"), forType: .string)
                    completionHandler(nil)
                }
            }
            return progress
        }

        private struct ShareRowDto: Decodable {
            let token: String
            let fileId: String
            let expiresAt: UInt64?
            let maxDownloads: UInt64?
            let protected: Bool
        }
        private struct ShareListDto: Decodable { let shares: [ShareRowDto] }
        private struct CreatedShareDto: Decodable { let token: String }

        private static func shareLink(record: HandoffRecord, entry: IndexEntry) -> String? {
            var token: String?
            if let listed = EngramApi.getJson(record: record, path: "/api/shares"),
               let list = try? JSONDecoder().decode(ShareListDto.self, from: listed) {
                token = list.shares.first {
                    $0.fileId == entry.id && !$0.protected
                        && $0.expiresAt == nil && $0.maxDownloads == nil
                }?.token
            }
            if token == nil,
               let created = EngramApi.json(
                   record: record, method: "POST", path: "/api/shares",
                   payload: ["fileId": entry.id]
               ) {
                token = (try? JSONDecoder().decode(CreatedShareDto.self, from: created))?.token
            }
            guard let token else { return nil }
            let key = entry.key.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
            return "\(record.origin)/s/\(token)#\(key)"
        }
    }
#endif
