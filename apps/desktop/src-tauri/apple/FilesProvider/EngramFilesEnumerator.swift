import FileProvider

/// Listing and change reporting over the synced index. The sync anchor is
/// the account's sequence cursor; a change request refreshes the index
/// and reports what moved past the anchor, which is exactly the delta the
/// server's paged sync feed hands out.
final class EngramFilesEnumerator: NSObject, NSFileProviderEnumerator {
    private let index: EngramFilesIndex
    private let container: NSFileProviderItemIdentifier

    init(index: EngramFilesIndex, container: NSFileProviderItemIdentifier) {
        self.index = index
        self.container = container
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        index.refresh()
        let parent: String?
        switch container {
        case .rootContainer, .workingSet:
            parent = nil
        default:
            parent = container.rawValue
        }
        if container == .workingSet {
            // The working set: what Files shows in Recents and searches.
            // Everything in a read-only vault index is cheap enough to
            // offer; the system trims for itself.
            observer.didEnumerate(index.entries.values.map(EngramFilesItem.init))
        } else {
            observer.didEnumerate(index.children(of: parent).map(EngramFilesItem.init))
        }
        observer.finishEnumerating(upTo: nil)
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        let since = Int(String(data: anchor.rawValue, encoding: .utf8) ?? "0") ?? 0
        let changedIds = index.refresh()
        var updated: [EngramFilesItem] = []
        var deleted: [NSFileProviderItemIdentifier] = []
        for id in Set(changedIds) {
            if let entry = index.entry(id) {
                if entry.updateSeq > since {
                    updated.append(EngramFilesItem(entry))
                }
            } else {
                deleted.append(NSFileProviderItemIdentifier(rawValue: id))
            }
        }
        // Items whose fetch failed carry a bumped version; deliver them
        // regardless of the anchor, or the replica that dropped their
        // placeholder would never hear about them again.
        let already = Set(updated.map { $0.itemIdentifier.rawValue })
        for id in FetchFailures.shared.all() where !already.contains(id) {
            if let entry = index.entry(id) {
                updated.append(EngramFilesItem(entry))
            }
        }
        if !updated.isEmpty {
            observer.didUpdate(updated)
        }
        if !deleted.isEmpty {
            observer.didDeleteItems(withIdentifiers: deleted)
        }
        observer.finishEnumeratingChanges(upTo: currentAnchor, moreComing: false)
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(currentAnchor)
    }

    private var currentAnchor: NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(Data("\(index.cursor)".utf8))
    }
}
