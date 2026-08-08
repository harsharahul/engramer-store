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

    required init(domain: NSFileProviderDomain) {
        super.init()
        reconnectIfNeeded()
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

    func fetchContents(
        for itemIdentifier: NSFileProviderItemIdentifier,
        version requestedVersion: NSFileProviderItemVersion?,
        request: NSFileProviderRequest,
        completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        reconnectIfNeeded()
        let progress = Progress(totalUnitCount: 2)
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
        URLSession.shared.dataTask(with: download) { data, response, _ in
            progress.completedUnitCount = 1
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data else {
                completionHandler(nil, nil, NSFileProviderError(.serverUnreachable))
                return
            }
            do {
                let plain = try decryptContent(blob: data, fileKey: entry.key)
                // The digest sealed in the metadata is the end-to-end
                // truth; a mismatch means wrong bytes, and wrong bytes
                // are never handed to another app.
                if let digest = entry.digest, contentDigest(bytes: plain) != digest {
                    completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
                    return
                }
                let staged = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString)
                try plain.write(to: staged, options: .atomic)
                progress.completedUnitCount = 2
                completionHandler(staged, EngramFilesItem(entry), nil)
            } catch {
                completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
            }
        }.resume()
        return progress
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
        guard let plain = try? Data(contentsOf: contents) else {
            return .failed("replacement bytes unreadable")
        }
        // Reuse the existing file key by sealing manually: metadata JSON is
        // decrypted, updated, resealed; content goes through the stream
        // format under the same key.
        guard let metaJson = try? decryptMetadataJson(
            encryptedMetaJson: entry.encryptedMetaJson, objectKey: entry.key
        ), var meta = (try? JSONSerialization.jsonObject(with: Data(metaJson.utf8))) as? [String: Any]
        else { return .failed("metadata unreadable") }

        let sealedContent: Data
        do {
            sealedContent = try encryptContent(plain: plain, fileKey: entry.key)
            try sealedContent.write(to: scratch)
        } catch {
            return .failed("encryption failed")
        }

        let outcome = EngramApi.uploadContent(record: record, fileId: entry.id, blob: scratch)
        guard case .ok = outcome else { return outcome }

        meta["digest"] = contentDigest(bytes: plain)
        meta["size"] = plain.count
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
        return EngramFilesEnumerator(index: index, container: containerItemIdentifier)
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
