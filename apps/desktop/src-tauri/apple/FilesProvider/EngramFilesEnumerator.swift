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
        // Reconciliation, the contract-honoring way: change enumeration
        // must converge, so items are never pushed past the anchor.
        // When something warrants a reconcile, the anchor is declared
        // expired ONCE and the system re-runs the full listing itself,
        // resurrecting anything its replica dropped. Delivering items
        // anchor-independently instead is what iOS answers with
        // "syncing paused".
        if container == .workingSet, ReconcileState.shared.due {
            ReconcileState.shared.delivered()
            indexLog.info("reconcile: sync anchor expired for a full re-listing")
            observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
            return
        }
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
        // Bounded batches; one call carrying a whole library reads as
        // misbehavior to a strict provider host.
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
