import Foundation

/// How the drive reads a refused write, decided by the HTTP status alone
/// so the rule is one function that tests can hold on a Mac without a
/// provider process. Each case is a different word to the system (see
/// FileProviderExtension.providerError): a dead token asks for the app,
/// a gone item leaves the disk, a rejected request stops being retried,
/// and only an absent or failing server backs the whole drive off.
///
/// Before this rule every refusal but 401 read as "unreachable". The
/// system answers that word by throttling the domain until its next
/// signal, which is right for a server that is down and wrong for a
/// request it will refuse again: one create the server answered with
/// 404 was retried as "unreachable" for two weeks, and every remote
/// change waited behind it.
enum EngramWriteVerdict: Error, Equatable {
    /// 401: the stored token is expired, revoked, or from before a
    /// password change. Only the app can replace it.
    case notAuthenticated
    /// 404: what the write names is gone (its folder, the file itself,
    /// an upload session), usually deleted from another device.
    case gone
    /// 409: a generation race or a live co-editing session. The content
    /// paths answer with a conflict copy, never with data loss.
    case conflict
    /// 413: the account has no room for these bytes.
    case overQuota
    /// Any other 4xx: the same request fails the same way next time, so
    /// retrying it would only keep the drive busy.
    case rejected(Int)
    /// No answer, no HTTP response, or a 5xx: the server, not the
    /// request, is the problem, and a later retry can succeed.
    case unreachable

    /// nil for a 2xx (nothing to report), otherwise the verdict. A nil
    /// status is a call that produced no HTTP response at all.
    static func refusal(status: Int?) -> EngramWriteVerdict? {
        guard let status else { return .unreachable }
        switch status {
        case 200..<300: return nil
        case 401: return .notAuthenticated
        case 404: return .gone
        case 409: return .conflict
        case 413: return .overQuota
        case 400..<500: return .rejected(status)
        default: return .unreachable
        }
    }
}
