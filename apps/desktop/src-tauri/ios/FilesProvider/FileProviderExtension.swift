import FileProvider
import UniformTypeIdentifiers

/// The vault in the Files app, read-only: browse, open, copy out. Every
/// byte leaves this process decrypted only after its digest matched the
/// one sealed inside the metadata. Writes arrive in the next iteration
/// with their conflict handling designed in; refusing them here is what
/// keeps the first shipped provider trustworthy.
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    private let index: EngramFilesIndex?
    private let record: HandoffRecord?

    required init(domain: NSFileProviderDomain) {
        self.record = EngramHandoff.read()
        self.index = record.flatMap(EngramFilesIndex.init)
        super.init()
    }

    func invalidate() {}

    func item(
        for identifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
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

    // Read-only: every mutation is declined in one place.
    func createItem(
        basedOn itemTemplate: NSFileProviderItem,
        fields: NSFileProviderItemFields,
        contents url: URL?,
        options: NSFileProviderCreateItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        completionHandler(nil, [], false, CocoaError(.featureUnsupported))
        return Progress()
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
        completionHandler(nil, [], false, CocoaError(.featureUnsupported))
        return Progress()
    }

    func deleteItem(
        identifier: NSFileProviderItemIdentifier,
        baseVersion version: NSFileProviderItemVersion,
        options: NSFileProviderDeleteItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (Error?) -> Void
    ) -> Progress {
        completionHandler(CocoaError(.featureUnsupported))
        return Progress()
    }

    func enumerator(
        for containerItemIdentifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest
    ) throws -> NSFileProviderEnumerator {
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
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading, .allowsContentEnumerating] }
    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: Data("root".utf8), metadataVersion: Data("root".utf8))
    }
}
