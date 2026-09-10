// One generation: parse the request, run the model, answer in the envelope.
// The call blocks the caller's thread (the Rust side runs it on a blocking
// pool) and always returns: the deadline in the request, plus a short
// grace, is enforced here as well as on the Rust side, so a stalled model
// can never hang a command. Cancellation is by job id.

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

private final class AnswerBox: @unchecked Sendable {
    private let lock = NSLock()
    private var answer = IntelEnvelope.error("timeout", "the model did not answer")

    func set(_ value: String) {
        lock.lock()
        answer = value
        lock.unlock()
    }

    func get() -> String {
        lock.lock()
        defer { lock.unlock() }
        return answer
    }
}

enum IntelGenerate {
    private static let lock = NSLock()
    private static var running: [String: Task<Void, Never>] = [:]
    private static let graceMs = 5_000

    static func run(requestJSON: String, emit: ((String) -> Void)?) -> String {
        guard let data = requestJSON.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let job = request["job"] as? String,
              let prompt = request["prompt"] as? String else {
            return IntelEnvelope.error("bad-request", "the request is not the expected JSON")
        }
        #if canImport(FoundationModels)
        guard #available(macOS 26, iOS 26, *) else {
            return IntelEnvelope.error("unavailable", "os-too-old")
        }
        let deadlineMs = (request["deadlineMs"] as? Int) ?? 8_000
        let box = AnswerBox()
        let done = DispatchSemaphore(value: 0)
        let task = Task {
            box.set(await perform(request, prompt: prompt, emit: emit))
            done.signal()
        }
        register(job, task)
        let waited = done.wait(timeout: .now() + .milliseconds(deadlineMs + graceMs))
        unregister(job)
        if waited == .timedOut {
            task.cancel()
            return IntelEnvelope.error("timeout", "no answer within \(deadlineMs) ms")
        }
        return box.get()
        #else
        _ = (job, prompt, emit)
        return IntelEnvelope.error("unavailable", "build-without-sdk")
        #endif
    }

    static func cancel(job: String) {
        lock.lock()
        let task = running.removeValue(forKey: job)
        lock.unlock()
        task?.cancel()
    }

    private static func register(_ job: String, _ task: Task<Void, Never>) {
        lock.lock()
        running[job] = task
        lock.unlock()
    }

    private static func unregister(_ job: String) {
        lock.lock()
        running.removeValue(forKey: job)
        lock.unlock()
    }

    #if canImport(FoundationModels)
    @available(macOS 26, iOS 26, *)
    private static func perform(_ request: [String: Any], prompt: String, emit: ((String) -> Void)?) async -> String {
        let wanted = (request["model"] as? String) ?? "system"
        let model: SystemLanguageModel = wanted == "tagging"
            ? SystemLanguageModel(useCase: .contentTagging)
            : SystemLanguageModel.default
        guard case .available = model.availability else {
            return IntelEnvelope.error("unavailable", "the model is not available on this device")
        }
        let instructions = (request["instructions"] as? String) ?? ""
        let session = instructions.isEmpty
            ? LanguageModelSession(model: model)
            : LanguageModelSession(model: model, instructions: instructions)
        let options = GenerationOptions(
            temperature: request["temperature"] as? Double,
            maximumResponseTokens: request["maxTokens"] as? Int)
        do {
            if let schemaJSON = request["schema"] as? [String: Any] {
                let schema = try IntelSchema.build(schemaJSON)
                let response = try await session.respond(to: prompt, schema: schema, options: options)
                guard let data = response.content.jsonString.data(using: .utf8),
                      let value = try? JSONSerialization.jsonObject(with: data) else {
                    return IntelEnvelope.error("other", "the guided answer was not JSON")
                }
                return IntelEnvelope.ok(value)
            }
            if let emit, (request["stream"] as? Bool) == true {
                var latest = ""
                for try await partial in session.streamResponse(to: prompt, options: options) {
                    latest = partial.content
                    emit(latest)
                }
                return IntelEnvelope.ok(latest)
            }
            let response = try await session.respond(to: prompt, options: options)
            return IntelEnvelope.ok(response.content)
        } catch is CancellationError {
            return IntelEnvelope.error("cancelled", "")
        } catch let error as IntelSchemaError {
            return IntelEnvelope.error("bad-request", error.detail)
        } catch let error as LanguageModelSession.GenerationError {
            return IntelEnvelope.error(code(for: error), error.localizedDescription)
        } catch {
            return IntelEnvelope.error("other", "\(error)")
        }
    }

    @available(macOS 26, iOS 26, *)
    private static func code(for error: LanguageModelSession.GenerationError) -> String {
        switch error {
        case .guardrailViolation:
            return "guardrail"
        case .exceededContextWindowSize:
            return "context-too-long"
        case .rateLimited:
            return "rate-limited"
        case .unsupportedLanguageOrLocale:
            return "language"
        default:
            return "other"
        }
    }
    #endif
}
