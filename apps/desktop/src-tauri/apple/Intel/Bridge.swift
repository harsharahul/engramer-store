// The C surface of the on-device assistant shim. Three entry points, JSON
// in and JSON out; every returned string is malloc'd here and released by
// the caller through engram_intel_free. The Rust side (src/intel.rs) is the
// only caller.

import Foundation

public typealias EngramChunkCallback = @convention(c) (UnsafePointer<CChar>, UnsafeMutableRawPointer?) -> Void

private func handBack(_ text: String) -> UnsafeMutablePointer<CChar> {
    return strdup(text)
}

@_cdecl("engram_intel_free")
public func engram_intel_free(_ pointer: UnsafeMutablePointer<CChar>?) {
    if let pointer {
        free(pointer)
    }
}

@_cdecl("engram_intel_availability")
public func engram_intel_availability() -> UnsafeMutablePointer<CChar> {
    return handBack(IntelAvailability.json())
}

@_cdecl("engram_intel_generate")
public func engram_intel_generate(
    _ request: UnsafePointer<CChar>,
    _ onChunk: EngramChunkCallback?,
    _ context: UnsafeMutableRawPointer?
) -> UnsafeMutablePointer<CChar> {
    let json = String(cString: request)
    let emit: ((String) -> Void)? = onChunk.map { callback in
        { text in text.withCString { callback($0, context) } }
    }
    return handBack(IntelGenerate.run(requestJSON: json, emit: emit))
}

@_cdecl("engram_intel_cancel")
public func engram_intel_cancel(_ job: UnsafePointer<CChar>) {
    IntelGenerate.cancel(job: String(cString: job))
}

// MARK: - Envelopes

enum IntelEnvelope {
    static func encode(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else {
            return "{\"error\":\"other\",\"detail\":\"answer could not be encoded\"}"
        }
        return text
    }

    static func ok(_ value: Any) -> String {
        return encode(["ok": value])
    }

    static func error(_ code: String, _ detail: String) -> String {
        return encode(["error": code, "detail": detail])
    }
}
