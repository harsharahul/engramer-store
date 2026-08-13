import Foundation

/// In-process memory of exhausted fetches. The system's replica drops a
/// placeholder whose download failed and then trusts that verdict for as
/// long as the item's version stands still, which turned one bad-network
/// moment into a file silently missing from the drive. The salt rides
/// the item's metadata version, so a failed item looks changed and the
/// replica reconciles it instead. Monotonic on purpose: a salt never
/// resets within a process, and a fresh process changes versions again,
/// which costs one benign reconcile.
final class FetchFailures {
    static let shared = FetchFailures()
    private var epochs: [String: Int] = [:]
    private var total = 0
    private let lock = NSLock()

    func bump(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        epochs[id] = (epochs[id] ?? 0) + 1
        total += 1
    }

    /// Monotonic count of every recorded failure; the reconcile trigger
    /// compares it against the count it last acted on.
    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return total
    }

    func salt(_ id: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return epochs[id] ?? 0
    }

    func all() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(epochs.keys)
    }
}

/// When the replica is owed a reconcile, served as ONE sync-anchor
/// expiry (the system then re-runs the full listing itself; that is
/// the contract-sanctioned full resync, where pushing items past the
/// anchor is what a strict host answers with "syncing paused").
/// Triggers: evidence of a failed fetch on any platform, and on macOS
/// also once per fresh process and a slow cadence, because macOS's
/// replica drops placeholders for downloads it fails internally
/// without ever consulting this process.
final class ReconcileState {
    static let shared = ReconcileState()
    private let lock = NSLock()
    private var reconciledFailureCount = 0
    #if os(macOS)
        private var freshProcess = true
        private var last = Date.distantPast
        private let cadence: TimeInterval = 600
    #endif

    var due: Bool {
        lock.lock()
        defer { lock.unlock() }
        if FetchFailures.shared.count > reconciledFailureCount {
            return true
        }
        #if os(macOS)
            return freshProcess || Date().timeIntervalSince(last) > cadence
        #else
            return false
        #endif
    }

    func delivered() {
        lock.lock()
        defer { lock.unlock() }
        reconciledFailureCount = FetchFailures.shared.count
        #if os(macOS)
            freshProcess = false
            last = Date()
        #endif
    }
}
