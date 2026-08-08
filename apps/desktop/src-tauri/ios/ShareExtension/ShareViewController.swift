import UIKit
import UniformTypeIdentifiers

/// "Save to Engram Store" from the system share sheet.
///
/// Everything sensitive happens on this device before any network:
/// each item is encrypted through the Rust core (streaming, one chunk
/// in memory) under a fresh file key sealed to the account's master key
/// from the shared keychain. The ciphertext is staged in the app group
/// and handed to a background URLSession, so the sheet can close while
/// bytes are still leaving. The vault record itself is created first,
/// digest included, so nothing needs to run after the upload lands.
final class ShareViewController: UIViewController {
    private let status = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var remaining = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        // The system sizes this sheet from preferredContentSize; without
        // one it can collapse to the label's compressed width and render
        // the text one character per line.
        preferredContentSize = CGSize(width: 360, height: 180)
        status.text = "Encrypting on this device…"
        status.font = .preferredFont(forTextStyle: .body)
        status.textAlignment = .center
        status.numberOfLines = 0
        spinner.startAnimating()
        let stack = UIStackView(arrangedSubviews: [spinner, status])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        process()
    }

    private func process() {
        let record: HandoffRecord
        switch EngramHandoff.readDetailed() {
        case .success(let found):
            record = found
        case .failure(let why):
            // The failure detail is what makes a report from the device
            // actionable: "no stored key" and "keychain error -34018"
            // have entirely different fixes.
            finish(with: ShareError.notSignedIn, detail: why.detail)
            return
        }
        guard !record.tokenLooksStale else {
            finish(with: ShareError.staleToken)
            return
        }
        guard let master = record.masterKeyBytes, master.count == 32 else {
            finish(with: ShareError.notSignedIn)
            return
        }
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []
        let files = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.data.identifier) }
        guard !files.isEmpty else {
            finish(with: ShareError.unreadableItem)
            return
        }
        remaining = files.count
        let session = EngramApi.backgroundSession()
        for provider in files {
            provider.loadFileRepresentation(forTypeIdentifier: UTType.data.identifier) { url, _ in
                // The system deletes the provided file when this block
                // returns; it must be copied out synchronously.
                guard let url else {
                    self.oneDone(failed: true)
                    return
                }
                let staged = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString)
                    .appendingPathExtension(url.pathExtension)
                do {
                    try FileManager.default.copyItem(at: url, to: staged)
                } catch {
                    self.oneDone(failed: true)
                    return
                }
                self.ship(staged: staged, name: url.lastPathComponent, record: record, master: master, session: session)
            }
        }
    }

    private func ship(staged: URL, name: String, record: HandoffRecord, master: Data, session: URLSession) {
        DispatchQueue.global(qos: .userInitiated).async {
            defer { try? FileManager.default.removeItem(at: staged) }
            let mtime = (try? FileManager.default.attributesOfItem(atPath: staged.path)[.modificationDate] as? Date)
                .map { UInt64($0.timeIntervalSince1970 * 1000) } ?? UInt64(Date().timeIntervalSince1970 * 1000)
            let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let envelope: UploadEnvelope
            do {
                envelope = try encryptForUpload(
                    inputPath: staged.path,
                    outputPath: scratch.path,
                    masterKey: master,
                    name: name,
                    mime: Self.mime(for: staged),
                    mtimeMs: mtime,
                    sourceId: nil
                )
            } catch {
                try? FileManager.default.removeItem(at: scratch)
                self.oneDone(failed: true)
                return
            }
            EngramApi.createFile(
                record: record,
                encryptedKeyJSON: envelope.encryptedKeyJson,
                encryptedMetaJSON: envelope.encryptedMetaJson
            ) { result in
                switch result {
                case .failure:
                    try? FileManager.default.removeItem(at: scratch)
                    self.oneDone(failed: true)
                case .success(let fileId):
                    guard let blob = EngramOutbox.blobURL(fileId: fileId) else {
                        self.oneDone(failed: true)
                        return
                    }
                    try? FileManager.default.removeItem(at: blob)
                    do {
                        try FileManager.default.moveItem(at: scratch, to: blob)
                    } catch {
                        self.oneDone(failed: true)
                        return
                    }
                    EngramOutbox.write(job: OutboxJob(
                        fileId: fileId,
                        name: name,
                        bytes: envelope.ciphertextSize,
                        createdAt: Date(),
                        state: "uploading"
                    ))
                    EngramApi.enqueueUpload(session: session, record: record, fileId: fileId, blob: blob)
                    self.oneDone(failed: false)
                }
            }
        }
    }

    private var failures = 0

    private func oneDone(failed: Bool) {
        DispatchQueue.main.async {
            if failed { self.failures += 1 }
            self.remaining -= 1
            if self.remaining > 0 { return }
            if self.failures > 0 {
                self.finish(with: ShareError.serverRefused)
            } else {
                self.status.text = "Queued. Uploads continue in the background."
                self.spinner.stopAnimating()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    self.extensionContext?.completeRequest(returningItems: nil)
                }
            }
        }
    }

    private func finish(with error: ShareError, detail: String? = nil) {
        DispatchQueue.main.async {
            self.spinner.stopAnimating()
            let message = error.errorDescription ?? "Something went wrong."
            self.status.text = detail.map { "\(message)\n(\($0))" } ?? message
            // Long enough to read; a fast auto-dismiss looks like a crash.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) {
                self.extensionContext?.cancelRequest(withError: error)
            }
        }
    }

    private static func mime(for url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }
}
