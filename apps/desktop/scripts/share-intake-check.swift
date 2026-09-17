import Foundation

// Compiled together with ShareIntake.swift by share-intake.test.mjs and
// run on the Mac: the extension's reading of the share sheet, checked
// without a device. Each failing check prints and the process exits 1.

var failures = 0

func check(_ condition: Bool, _ message: String) {
    if !condition {
        failures += 1
        print("FAIL: \(message)")
    }
}

// Safari's share button on a page: the URL, the preprocessing results,
// and often the title as text. Exactly one page item results.
let safariPage: [[String]] = [
    ["public.url"],
    ["com.apple.property-list"],
    ["public.plain-text"],
]
check(ShareIntake.plan(for: safariPage) == [.webPage, .skip, .skip], "a Safari page is one page item")

// A PDF from Safari's Options menu arrives as a file plus the page URL.
let safariPdf: [[String]] = [["public.file-url", "com.adobe.pdf"], ["public.url"]]
check(ShareIntake.plan(for: safariPdf) == [.file, .webPage], "a Safari PDF keeps the file and the page")

// Photos hands over image files.
check(ShareIntake.plan(for: [["public.file-url", "public.image"], ["public.file-url", "public.image"]]) == [.file, .file],
      "photos are files")

// A bare image payload without a file URL (some apps) is still a file.
check(ShareIntake.plan(for: [["public.jpeg", "public.image"]]) == [.file], "an image without a file url is a file")

// Selected text on its own is a text file.
check(ShareIntake.plan(for: [["public.plain-text"]]) == [.text], "text alone is a text file")

// Nothing recognisable is skipped rather than uploaded as garbage.
check(ShareIntake.plan(for: [["dyn.ah62d4"]]) == [.skip], "an unknown dynamic type is skipped")

// Names.
let page = URL(string: "https://example.com/articles/how-to-file-taxes?ref=1")!
check(ShareIntake.pdfName(title: "How to file: taxes / 2026?", url: page) == "How to file taxes 2026.pdf",
      "a title becomes a safe pdf name, got \(ShareIntake.pdfName(title: "How to file: taxes / 2026?", url: page))")
check(ShareIntake.pdfName(title: nil, url: page) == "example.com.pdf", "no title falls back to the host")
check(ShareIntake.linkName(title: "", url: page) == "example.com.url", "an empty title falls back to the host")
let longTitle = String(repeating: "word ", count: 40)
check(ShareIntake.pdfName(title: longTitle, url: page).count <= 84, "long titles are capped")
check(ShareIntake.textName("Buy milk\nand eggs") == "Buy milk.txt", "text takes its first line as the name")
check(ShareIntake.textName("   \n") == "Shared text.txt", "blank text gets a fallback name")

// The link body is an Internet Shortcut with the title as a comment.
let body = ShareIntake.linkBody(url: page, title: "Taxes")
check(body.hasPrefix("[InternetShortcut]\r\nURL=https://example.com/articles/how-to-file-taxes?ref=1\r\n"),
      "the link body carries the URL")
check(body.contains("; Title=Taxes"), "the link body carries the title")

check(ShareIntake.isWebPage(URL(string: "https://a.example")!), "https is a page")
check(!ShareIntake.isWebPage(URL(string: "mailto:a@example.com")!), "mailto is not a page")
check(!ShareIntake.isWebPage(URL(fileURLWithPath: "/tmp/x")), "a file is not a page")

if failures > 0 {
    exit(1)
}
print("share intake: all checks passed")
