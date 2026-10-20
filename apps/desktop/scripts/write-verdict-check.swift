import Foundation

// Compiled together with EngramWriteVerdict.swift by write-verdict.test.mjs
// and run on the Mac: the drive's reading of a refused write, checked
// without a provider process. Each failing check prints and the process
// exits 1.

var failures = 0

func check(_ condition: Bool, _ message: String) {
    if !condition {
        failures += 1
        print("FAIL: \(message)")
    }
}

// A success has nothing to report.
for status in 200..<300 {
    check(EngramWriteVerdict.refusal(status: status) == nil, "\(status) is not a refusal")
}

// The statuses with a meaning of their own.
check(EngramWriteVerdict.refusal(status: 401) == .notAuthenticated, "401 asks for the app")
check(EngramWriteVerdict.refusal(status: 404) == .gone, "404 means the item or its parent is gone")
check(EngramWriteVerdict.refusal(status: 409) == .conflict, "409 is a conflict")
check(EngramWriteVerdict.refusal(status: 413) == .overQuota, "413 is the quota")

// Every other 4xx is a request the server will refuse again, and none
// of them may ever read as a connection problem: the system answers
// that word by backing the whole drive off, which is how one 404 on a
// stuck create held every remote change for two weeks.
for status in 400..<500 {
    let verdict = EngramWriteVerdict.refusal(status: status)
    check(verdict != .unreachable, "\(status) is never 'unreachable'")
    check(verdict != nil, "\(status) is a refusal")
    if ![401, 404, 409, 413].contains(status) {
        check(verdict == .rejected(status), "\(status) is rejected with its status")
    }
}

// The server itself failing, or not answering, is the one case worth a
// later retry.
check(EngramWriteVerdict.refusal(status: nil) == .unreachable, "no response is 'unreachable'")
for status in 500..<600 {
    check(EngramWriteVerdict.refusal(status: status) == .unreachable, "\(status) is 'unreachable'")
}
// Nothing else the session could hand back is read as a refusal.
for status in [100, 101, 301, 302, 304, 0, -1, 999] {
    check(EngramWriteVerdict.refusal(status: status) == .unreachable, "\(status) is 'unreachable'")
}

if failures > 0 {
    print("\(failures) check(s) failed")
    exit(1)
}
print("all checks passed")
