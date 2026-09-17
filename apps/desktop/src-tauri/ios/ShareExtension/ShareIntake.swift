import Foundation

/// What the share sheet handed over, and what each item becomes.
///
/// Safari's share button offers a web page as a URL plus, when the
/// extension asks for it, the page's title and selection from a
/// preprocessing script. Sharing an image or a PDF from Safari, or
/// anything from Files, hands over a file. Sharing text hands over text.
/// This is the pure part of that reading: it looks only at the type
/// identifiers each attachment registers, so it can be checked without
/// a device, and the controller does the loading it decides on.
enum ShareIntake {
    enum Plan: Equatable {
        /// A file, image or movie: encrypt and upload as is.
        case file
        /// A web page: render it to a PDF, or keep the link if that fails.
        case webPage
        /// A bare link that is not a web page (a custom scheme, mail).
        case link
        /// Plain text: a small text file.
        case text
        /// Nothing this extension stores (the page's preprocessing results
        /// ride with the page item, a duplicate representation is skipped).
        case skip
    }

    static let fileURLType = "public.file-url"
    static let urlType = "public.url"
    static let textType = "public.plain-text"
    static let propertyListType = "com.apple.property-list"
    static let dataType = "public.data"

    /// One plan per attachment, in the order given. A page share arrives
    /// as several attachments describing the same thing (the URL, the
    /// preprocessing results, sometimes the title as text); exactly one
    /// of them becomes the page and the rest are skipped.
    static func plan(for attachments: [[String]]) -> [Plan] {
        let hasPage = attachments.contains { types in
            types.contains(urlType) && !types.contains(fileURLType)
        }
        var pageTaken = false
        return attachments.map { types in
            if types.contains(fileURLType) {
                return .file
            }
            if types.contains(urlType) {
                if pageTaken {
                    return .skip
                }
                pageTaken = true
                return .webPage
            }
            if types.contains(propertyListType) {
                // The preprocessing results belong to the page item.
                return .skip
            }
            if types.contains(textType) {
                // Some apps add the page title as text beside the URL.
                return hasPage ? .skip : .text
            }
            // A concrete declared type (public.jpeg, com.adobe.pdf) is a
            // file even without a file URL; a dynamic type nobody declared
            // (dyn.*) is not something to store.
            if types.contains(dataType) || types.contains(where: { $0.hasPrefix("public.") || $0.hasPrefix("com.") || $0.hasPrefix("org.") }) {
                return .file
            }
            return .skip
        }
    }

    /// Whether a URL is a page a web view can render, as opposed to a
    /// custom scheme, mail, or a local file.
    static func isWebPage(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    /// A file name from a page title or URL: readable, safe on every
    /// file system, and short enough for a sidebar row.
    static func safeName(_ raw: String, fallback: String) -> String {
        var name = raw
            .replacingOccurrences(of: "[/\\\\:*?\"<>|\u{0000}-\u{001F}]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while name.hasSuffix(".") {
            name.removeLast()
        }
        if name.isEmpty {
            name = fallback
        }
        if name.count > 80 {
            name = String(name.prefix(80)).trimmingCharacters(in: .whitespaces)
        }
        return name
    }

    /// The page as a PDF: "<title>.pdf", or the host when there is no title.
    static func pdfName(title: String?, url: URL) -> String {
        safeName(title ?? "", fallback: url.host ?? "Web page") + ".pdf"
    }

    /// The page as a link file: "<title>.url".
    static func linkName(title: String?, url: URL) -> String {
        safeName(title ?? "", fallback: url.host ?? "Link") + ".url"
    }

    /// The body of a .url file: the Internet Shortcut form Windows, Files
    /// and this app read. The title rides as a comment line.
    static func linkBody(url: URL, title: String?) -> String {
        var lines = ["[InternetShortcut]", "URL=\(url.absoluteString)"]
        if let title, !title.isEmpty {
            lines.append("; Title=\(title.replacingOccurrences(of: "\n", with: " "))")
        }
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    /// A text share becomes "<first line>.txt".
    static func textName(_ text: String) -> String {
        let firstLine = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return safeName(firstLine, fallback: "Shared text") + ".txt"
    }
}
