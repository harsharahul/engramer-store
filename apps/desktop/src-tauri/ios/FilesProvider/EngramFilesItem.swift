import FileProvider
import UniformTypeIdentifiers

/// One row of the vault as the Files app sees it. Read-only in this
/// iteration: reading and enumerating, nothing else, which keeps the
/// entire conflict surface out of the first shipped provider.
final class EngramFilesItem: NSObject, NSFileProviderItem {
    let entry: IndexEntry

    init(_ entry: IndexEntry) {
        self.entry = entry
    }

    var itemIdentifier: NSFileProviderItemIdentifier {
        NSFileProviderItemIdentifier(rawValue: entry.id)
    }

    var parentItemIdentifier: NSFileProviderItemIdentifier {
        guard let parent = entry.parentId else { return .rootContainer }
        return NSFileProviderItemIdentifier(rawValue: parent)
    }

    var filename: String {
        // The server allows duplicate names inside a folder; the Files
        // app does not. The index suffixes duplicates when it decrypts.
        entry.displayName
    }

    var contentType: UTType {
        if entry.isFolder {
            return .folder
        }
        return UTType(mimeType: entry.mime ?? "") ?? .data
    }

    var documentSize: NSNumber? {
        // The plaintext size out of the encrypted metadata; the row's own
        // size column is ciphertext and would read visibly wrong.
        entry.isFolder ? nil : NSNumber(value: entry.plainSize ?? 0)
    }

    var contentModificationDate: Date? {
        entry.mtimeMs.map { Date(timeIntervalSince1970: Double($0) / 1000) }
    }

    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(
            contentVersion: Data("\(entry.generation ?? 0)".utf8),
            metadataVersion: Data("\(entry.updateSeq)".utf8)
        )
    }

    var capabilities: NSFileProviderItemCapabilities {
        if entry.isFolder {
            // Folder rename/move/delete wait for their own pass; adding
            // items into a folder works now.
            return [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems]
        }
        return [.allowsReading, .allowsWriting, .allowsRenaming, .allowsReparenting, .allowsDeleting]
    }
}
