import FileProvider

/// Listing and change reporting over the synced index. The sync anchor is
/// the account's sequence cursor; a change request refreshes the index
/// and reports what moved past the anchor, which is exactly the delta the
/// server's paged sync feed hands out.
final class EngramFilesEnumerator: NSObject, NSFileProviderEnumerator {
    private let index: EngramFilesIndex
    private let container: NSFileProviderItemIdentifier
    private let onFreshData: () -> Void

    init(
        index: EngramFilesIndex,
        container: NSFileProviderItemIdentifier,
        onFreshData: @escaping () -> Void = {}
    ) {
        self.index = index
        self.container = container
        self.onFreshData = onFreshData
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        // A listing answers at memory speed from whatever the index
        // holds; freshness arrives through the change path a moment
        // later. Only an EMPTY index (first run of a process that could
        // not load a persisted one) is worth blocking a window for.
        if index.isEmpty {
            index.refresh()
        } else {
            index.refreshSoon { [onFreshData] _ in onFreshData() }
        }
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
            observer.didEnumerate(index.entriesSnapshot().map(EngramFilesItem.init))
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
        var already = Set(updated.map { $0.itemIdentifier.rawValue })
        for id in FetchFailures.shared.all() where !already.contains(id) {
            if let entry = index.entry(id) {
                updated.append(EngramFilesItem(entry))
                already.insert(id)
            }
        }
        // The periodic full redelivery: resurrects anything the system
        // dropped on its own (it fails offline materializations without
        // consulting this process, so no hook can see them happen).
        if container == .workingSet, ReconcileState.shared.due {
            let snapshot = index.entriesSnapshot()
            for entry in snapshot where !already.contains(entry.id) {
                updated.append(EngramFilesItem(entry))
            }
            ReconcileState.shared.delivered()
            indexLog.info("reconcile: full set redelivered (\(snapshot.count, privacy: .public) items)")
        }
        // Bounded batches: handing the observer hundreds of items in one
        // call is what a strict provider host treats as misbehavior.
        for start in stride(from: 0, to: updated.count, by: 100) {
            observer.didUpdate(Array(updated[start..<min(start + 100, updated.count)]))
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
        NSFileProviderSyncAnchor(Data("\(index.syncCursor)".utf8))
    }
}
