// Whether this device can run the assistant, and why not when it cannot.
// The answer is one JSON object: {"state":"available","contextSize":N} or
// {"state":"unavailable","reason":<code>}. The reason codes are the
// vocabulary the web app turns into one honest sentence.

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

enum IntelAvailability {
    static func json() -> String {
        #if canImport(FoundationModels)
        if #available(macOS 26, iOS 26, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                var contextSize = 4096
                if #available(macOS 26.4, iOS 26.4, *) {
                    contextSize = model.contextSize
                }
                return IntelEnvelope.encode(["state": "available", "contextSize": contextSize])
            case .unavailable(let reason):
                let code: String
                switch reason {
                case .appleIntelligenceNotEnabled:
                    code = "intelligence-off"
                case .deviceNotEligible:
                    code = "device-ineligible"
                case .modelNotReady:
                    code = "model-not-ready"
                @unknown default:
                    code = "device-ineligible"
                }
                return IntelEnvelope.encode(["state": "unavailable", "reason": code])
            }
        }
        return IntelEnvelope.encode(["state": "unavailable", "reason": "os-too-old"])
        #else
        return IntelEnvelope.encode(["state": "unavailable", "reason": "build-without-sdk"])
        #endif
    }
}
