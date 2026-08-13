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
    private let lock = NSLock()

    func bump(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        epochs[id] = (epochs[id] ?? 0) + 1
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

/// When the working set owes the replica a full redelivery. The system
/// drops placeholders for downloads IT failed internally, without ever
/// consulting the extension, and a dropped item filtered by the sync
/// anchor would otherwise stay invisible forever. Redelivering the
/// whole index is a few hundred metadata rows: cheap insurance that
/// makes the drive self-correcting against any replica divergence.
final class ReconcileState {
    static let shared = ReconcileState()
    private let lock = NSLock()
    private var dueFlag = true // a fresh process reconciles once
    private var last = Date.distantPast
    private let cadence: TimeInterval = 600

    var due: Bool {
        lock.lock()
        defer { lock.unlock() }
        return dueFlag || Date().timeIntervalSince(last) > cadence
    }

    func request() {
        lock.lock()
        defer { lock.unlock() }
        dueFlag = true
    }

    func delivered() {
        lock.lock()
        defer { lock.unlock() }
        dueFlag = false
        last = Date()
    }
}
