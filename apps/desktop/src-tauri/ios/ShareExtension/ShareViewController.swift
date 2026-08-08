import UIKit
import UniformTypeIdentifiers

/// "Save to Engram Store" from the system share sheet.
///
/// The sheet opens on a destination chooser: Smart classify (the Inbox
/// the app sorts on its next open), the vault root, or a folder from
/// the drive's cached listing, with the last choice remembered. From
/// there, everything sensitive happens on this device before any
/// network: each item is encrypted through the Rust core (streaming,
/// one chunk in memory) under a fresh file key sealed to the account's
/// master key from the shared keychain. The ciphertext is staged in the
/// app group and handed to a background URLSession, so the sheet can
/// close while bytes are still leaving. The vault record itself is
/// created first, digest included, so nothing needs to run after the
/// upload lands.
final class ShareViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private let status = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let header = UILabel()
    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private var remaining = 0
    private var record: HandoffRecord?
    private var master: Data?
    private var destinations: [Destination] = []

    /// One row of the chooser. `folderId` nil means the vault root.
    private struct Destination {
        let title: String
        let subtitle: String?
        let folderId: String?
        let kind: String
    }

    private static let lastKindKey = "share-destination-kind"
    private static let lastFolderIdKey = "share-destination-folder-id"
    private static let lastFolderNameKey = "share-destination-folder-name"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        // The system sizes this sheet from preferredContentSize; without
        // one it can collapse to the label's compressed width and render
        // the text one character per line.
        preferredContentSize = CGSize(width: 360, height: 420)

        header.font = .preferredFont(forTextStyle: .headline)
        header.text = "Save to Engram Store"
        header.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(header)

        table.dataSource = self
        table.delegate = self
        table.translatesAutoresizingMaskIntoConstraints = false
        table.isHidden = true
        view.addSubview(table)

        status.text = "Encrypting on this device…"
        status.font = .preferredFont(forTextStyle: .body)
        status.textAlignment = .center
        status.numberOfLines = 0
        let stack = UIStackView(arrangedSubviews: [spinner, status])
        stack.axis = .vertical
        stack.spacing = 12
        stack.isHidden = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 18),
            header.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            table.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
        statusStack = stack
    }

    private var statusStack: UIStackView?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard record == nil else { return }
        prepare()
    }

    /// Validates the handoff and shows the destination chooser; the
    /// upload starts when a row is tapped.
    private func prepare() {
        let found: HandoffRecord
        switch EngramHandoff.readDetailed() {
        case .success(let ok):
            found = ok
        case .failure(let why):
            // The failure detail is what makes a report from the device
            // actionable: "no stored key" and "keychain error -34018"
            // have entirely different fixes.
            finish(with: ShareError.notSignedIn, detail: why.detail)
            return
        }
        guard !found.tokenLooksStale else {
            finish(with: ShareError.staleToken)
            return
        }
        guard let key = found.masterKeyBytes, key.count == 32 else {
            finish(with: ShareError.notSignedIn)
            return
        }
        record = found
        master = key
        let count = ((extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []).count
        header.text = count > 1 ? "Save \(count) items to Engram Store" : "Save to Engram Store"
        destinations = buildDestinations(record: found)
        table.reloadData()
        table.isHidden = false
    }

    private func buildDestinations(record: HandoffRecord) -> [Destination] {
        var rows: [Destination] = [
            Destination(
                title: "Smart classify",
                subtitle: "Lands in Inbox; the app tags and categorizes it",
                folderId: record.inboxFolderId,
                kind: "smart"
            ),
            Destination(title: "Vault", subtitle: "The top level", folderId: nil, kind: "root"),
        ]
        // The drive's cached listing, when the Files provider has built
        // one: root-level folders, by name. No network from the sheet.
        if let index = EngramFilesIndex(record: record) {
            let folders = index.children(of: nil)
                .filter { $0.isFolder }
                .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            rows += folders.map {
                Destination(title: $0.displayName, subtitle: nil, folderId: $0.id, kind: "folder")
            }
        } else if let savedId = Self.groupDefaults?.string(forKey: Self.lastFolderIdKey),
                  let savedName = Self.groupDefaults?.string(forKey: Self.lastFolderNameKey) {
            // No listing yet, but a folder worked last time; offer it.
            rows.append(Destination(title: savedName, subtitle: "Last used", folderId: savedId, kind: "folder"))
        }
        return rows
    }

    private static var groupDefaults: UserDefaults? {
        UserDefaults(suiteName: EngramHandoff.appGroup)
    }

    // MARK: - Chooser table.

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        destinations.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        let destination = destinations[indexPath.row]
        cell.textLabel?.text = destination.title
        cell.detailTextLabel?.text = destination.subtitle
        cell.detailTextLabel?.textColor = .secondaryLabel
        let lastKind = Self.groupDefaults?.string(forKey: Self.lastKindKey)
        let lastFolder = Self.groupDefaults?.string(forKey: Self.lastFolderIdKey)
        let isLast = destination.kind == lastKind
            && (destination.kind != "folder" || destination.folderId == lastFolder)
        cell.accessoryType = isLast ? .checkmark : .none
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let destination = destinations[indexPath.row]
        let defaults = Self.groupDefaults
        defaults?.set(destination.kind, forKey: Self.lastKindKey)
        if destination.kind == "folder" {
            defaults?.set(destination.folderId, forKey: Self.lastFolderIdKey)
            defaults?.set(destination.title, forKey: Self.lastFolderNameKey)
        }
        header.isHidden = true
        table.isHidden = true
        statusStack?.isHidden = false
        spinner.startAnimating()
        process(to: destination.folderId)
    }

    private func process(to folderId: String?) {
        guard let record, let master else {
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
                self.ship(staged: staged, name: url.lastPathComponent, record: record,
                          master: master, session: session, folderId: folderId)
            }
        }
    }

    private func ship(staged: URL, name: String, record: HandoffRecord, master: Data,
                      session: URLSession, folderId: String?) {
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
                encryptedMetaJSON: envelope.encryptedMetaJson,
                folderId: folderId
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
