import UIKit
import WebKit

/// Renders a web page to a PDF inside the extension, within a budget.
///
/// The page loads in an off-screen web view the size of a sheet of
/// paper, with media that would play by itself blocked, and is written
/// to a PDF once it has finished loading and settled for a moment. A
/// page that has not finished within the budget, or fails to load, gives
/// nil, and the caller keeps a link instead. Everything happens in this
/// process: the page's content goes nowhere but the vault.
final class PageRenderer: NSObject, WKNavigationDelegate {
    static let shared = PageRenderer()

    private var webView: WKWebView?
    private var completion: ((Data?) -> Void)?
    private var deadline: DispatchWorkItem?
    /// Time for late images and fonts after the load reports done.
    private let settle: TimeInterval = 1.2

    func render(_ url: URL, budget: TimeInterval, completion: @escaping (Data?) -> Void) {
        assert(Thread.isMainThread)
        if self.completion != nil {
            // One page at a time; a second request while one is in flight
            // keeps its link.
            completion(nil)
            return
        }
        self.completion = completion
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.allowsInlineMediaPlayback = false
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 794, height: 1123), configuration: configuration)
        view.navigationDelegate = self
        view.isHidden = true
        webView = view
        let deadline = DispatchWorkItem { [weak self] in self?.finish(nil) }
        self.deadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + budget, execute: deadline)
        var request = URLRequest(url: url)
        request.timeoutInterval = budget
        view.load(request)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + settle) { [weak self] in
            guard let self, self.webView === webView, self.completion != nil else { return }
            let configuration = WKPDFConfiguration()
            webView.createPDF(configuration: configuration) { result in
                switch result {
                case .success(let data):
                    self.finish(data)
                case .failure:
                    self.finish(nil)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(nil)
    }

    private func finish(_ data: Data?) {
        assert(Thread.isMainThread)
        deadline?.cancel()
        deadline = nil
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView = nil
        let done = completion
        completion = nil
        done?(data)
    }
}
