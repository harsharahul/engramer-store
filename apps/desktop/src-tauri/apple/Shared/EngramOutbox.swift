import Foundation

/// Staged ciphertext waiting for its background upload, plus the job
/// record that lets the containing app reconcile later. One JSON file
/// per job beside the blob; simple, inspectable, and crash-safe enough
/// for the share flow. (The backup stage will grow this into a real
/// database when it needs querying.)
struct OutboxJob: Codable {
    let fileId: String
    let name: String
    let bytes: UInt64
    let createdAt: Date
    var state: String
}

enum EngramOutbox {
    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: EngramHandoff.appGroup)
    }

    static var directory: URL? {
        guard let root = container?.appendingPathComponent("outbox", isDirectory: true) else { return nil }
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    static func blobURL(fileId: String) -> URL? {
        directory?.appendingPathComponent("\(fileId).bin")
    }

    static func write(job: OutboxJob) {
        guard let dir = directory,
              let data = try? JSONEncoder().encode(job)
        else { return }
        try? data.write(to: dir.appendingPathComponent("\(job.fileId).job.json"), options: .atomic)
    }
}
