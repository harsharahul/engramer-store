//! On-device assistant: Apple's Foundation Models, reached through a small
//! Swift shim compiled into this binary. The web app hands over a prompt
//! and a schema, the model answers on this device, and nothing leaves it.
//!
//! The shim speaks JSON over three C entry points (availability, generate,
//! cancel). This module owns the policy around them: one generation at a
//! time per process, an interactive request preempting a background one,
//! and a deadline on every call so a promise in the web view always
//! settles. On a build without the shim (no Swift toolchain, or a
//! non-Apple target) every command answers "unavailable" and the app is
//! exactly what it was before.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::future::Future;
use std::sync::Mutex;
use tauri::Emitter;

/// Interactive work (a search parse, a question) outranks background work
/// (a summary pass): the pass is cancelled, told so, and asked again.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Interactive,
    Background,
}

/// One generation. The web side builds it; the shim reads the same shape.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub job: String,
    /// "system" or "tagging"; "mlx" is reserved for a larger local model.
    pub model: String,
    pub instructions: String,
    pub prompt: String,
    /// A JSON-schema subset the shim turns into guided generation; absent
    /// means a plain string answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<serde_json::Value>,
    #[serde(default)]
    pub stream: bool,
    pub max_tokens: u32,
    pub temperature: f32,
    pub deadline_ms: u64,
    #[serde(default = "Priority::background")]
    pub priority: Priority,
}

impl Priority {
    fn background() -> Self {
        Priority::Background
    }
}

/// A typed refusal. `code` is the contract the web side switches on.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct IntelError {
    pub code: String,
    pub detail: String,
}

impl IntelError {
    fn new(code: &str, detail: impl Into<String>) -> Self {
        IntelError { code: code.to_string(), detail: detail.into() }
    }
}

const KNOWN_CODES: &[&str] = &[
    "unavailable",
    "cancelled",
    "preempted",
    "guardrail",
    "context-too-long",
    "rate-limited",
    "language",
    "timeout",
    "bad-request",
];

/// The shim answers `{"ok": value}` or `{"error": code, "detail": text}`.
/// A code this build does not know collapses to "other" with the code kept
/// as the detail, so a newer shim never produces an unreadable answer.
pub fn decode_answer(raw: &str) -> Result<serde_json::Value, IntelError> {
    let parsed: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return Err(IntelError::new("other", "the shim answered with something other than JSON")),
    };
    if let Some(ok) = parsed.get("ok") {
        return Ok(ok.clone());
    }
    let code = parsed.get("error").and_then(|v| v.as_str()).unwrap_or("other");
    let detail = parsed.get("detail").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if KNOWN_CODES.contains(&code) {
        Err(IntelError::new(code, detail))
    } else {
        Err(IntelError::new("other", if detail.is_empty() { code.to_string() } else { detail }))
    }
}

/// The shim's availability answer, passed through as-is; anything
/// unreadable means the shim was not built with the framework.
pub fn decode_availability(raw: &str) -> serde_json::Value {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) if value.get("state").is_some() => value,
        _ => serde_json::json!({ "state": "unavailable", "reason": "build-without-sdk" }),
    }
}

/// What the gate says to a request.
#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    /// The slot is free: start now.
    Start,
    /// Something of equal or higher rank is running: wait for the slot.
    Wait,
    /// A background job holds the slot: cancel it, then take the slot.
    Preempt { cancel: String },
}

/// Who holds the single generation slot, and who was pushed out of it.
#[derive(Default)]
pub struct Gate {
    current: Option<(String, Priority)>,
    preempted: HashSet<String>,
}

impl Gate {
    pub fn admit(&mut self, _job: &str, priority: Priority) -> Admission {
        match &self.current {
            None => Admission::Start,
            Some((running, Priority::Background)) if priority == Priority::Interactive => {
                self.preempted.insert(running.clone());
                Admission::Preempt { cancel: running.clone() }
            }
            Some(_) => Admission::Wait,
        }
    }

    pub fn started(&mut self, job: &str, priority: Priority) {
        self.current = Some((job.to_string(), priority));
    }

    pub fn finished(&mut self, job: &str) {
        if matches!(&self.current, Some((running, _)) if running == job) {
            self.current = None;
        }
    }

    /// True once per preempted job: the caller maps its "cancelled" answer
    /// to "preempted" so the web side retries instead of giving up.
    pub fn was_preempted(&mut self, job: &str) -> bool {
        self.preempted.remove(job)
    }
}

/// Runs a generation under a budget; on expiry the job is cancelled in the
/// shim and the caller gets "timeout".
pub async fn bounded<F>(
    job: &str,
    budget_ms: u64,
    work: F,
    cancel: impl FnOnce(&str),
) -> Result<serde_json::Value, IntelError>
where
    F: Future<Output = Result<serde_json::Value, IntelError>>,
{
    let budget = std::time::Duration::from_millis(budget_ms);
    match tokio::time::timeout(budget, work).await {
        Ok(outcome) => outcome,
        Err(_) => {
            cancel(job);
            Err(IntelError::new("timeout", format!("no answer within {budget_ms} ms")))
        }
    }
}

/// The shim enforces the deadline itself; this margin only covers the
/// hand-back, so a stuck shim can never hang a command forever.
const GRACE_MS: u64 = 5_000;

/// Where streamed chunks go: the command wraps an app event emitter.
pub type ChunkSink = Box<dyn Fn(&str) + Send + Sync>;

/// Process-wide state: the slot and its gate.
pub struct IntelState {
    slot: tokio::sync::Semaphore,
    gate: Mutex<Gate>,
}

impl Default for IntelState {
    fn default() -> Self {
        IntelState { slot: tokio::sync::Semaphore::new(1), gate: Mutex::new(Gate::default()) }
    }
}

#[cfg(engram_intel_shim)]
mod apple {
    //! The C surface of the Swift shim. Every string the shim returns is
    //! malloc'd on its side and handed back through `engram_intel_free`.

    use std::ffi::{c_char, c_void, CStr, CString};

    type ChunkCallback = Option<unsafe extern "C" fn(*const c_char, *mut c_void)>;

    extern "C" {
        fn engram_intel_availability() -> *mut c_char;
        fn engram_intel_generate(
            request: *const c_char,
            on_chunk: ChunkCallback,
            context: *mut c_void,
        ) -> *mut c_char;
        fn engram_intel_cancel(job: *const c_char);
        fn engram_intel_free(pointer: *mut c_char);
    }

    fn take(pointer: *mut c_char) -> String {
        if pointer.is_null() {
            return String::new();
        }
        let owned = unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned();
        unsafe { engram_intel_free(pointer) };
        owned
    }

    pub fn availability() -> String {
        take(unsafe { engram_intel_availability() })
    }

    unsafe extern "C" fn forward_chunk(text: *const c_char, context: *mut c_void) {
        if text.is_null() || context.is_null() {
            return;
        }
        let emit = &*(context as *const super::ChunkSink);
        emit(&CStr::from_ptr(text).to_string_lossy());
    }

    pub fn generate(request: &str, on_chunk: Option<super::ChunkSink>) -> String {
        let request = match CString::new(request) {
            Ok(text) => text,
            Err(_) => return r#"{"error":"bad-request","detail":"request holds a NUL byte"}"#.into(),
        };
        // The callback context lives on this stack frame for exactly as
        // long as the blocking call, which is the only time the shim may
        // call back.
        let holder = on_chunk;
        let context = holder
            .as_ref()
            .map(|boxed| boxed as *const super::ChunkSink as *mut c_void)
            .unwrap_or(std::ptr::null_mut());
        let callback: ChunkCallback = if holder.is_some() { Some(forward_chunk) } else { None };
        take(unsafe { engram_intel_generate(request.as_ptr(), callback, context) })
    }

    pub fn cancel(job: &str) {
        if let Ok(text) = CString::new(job) {
            unsafe { engram_intel_cancel(text.as_ptr()) };
        }
    }
}

#[cfg(not(engram_intel_shim))]
mod apple {
    //! No shim in this build: the assistant is absent and says so.

    pub fn availability() -> String {
        String::new()
    }

    pub fn generate(_request: &str, _on_chunk: Option<super::ChunkSink>) -> String {
        r#"{"error":"unavailable","detail":"build-without-sdk"}"#.to_string()
    }

    pub fn cancel(_job: &str) {}
}

#[tauri::command]
pub async fn intel_available() -> serde_json::Value {
    let raw = tauri::async_runtime::spawn_blocking(apple::availability)
        .await
        .unwrap_or_default();
    decode_availability(&raw)
}

#[tauri::command]
pub async fn intel_generate(
    app: tauri::AppHandle,
    state: tauri::State<'_, IntelState>,
    request: GenerateRequest,
) -> Result<serde_json::Value, IntelError> {
    let job = request.job.clone();
    let admission = state.gate.lock().map_err(|_| IntelError::new("other", "gate poisoned"))?.admit(&job, request.priority);
    if let Admission::Preempt { cancel } = admission {
        apple::cancel(&cancel);
    }
    let _permit = state
        .slot
        .acquire()
        .await
        .map_err(|_| IntelError::new("other", "slot closed"))?;
    if let Ok(mut gate) = state.gate.lock() {
        gate.started(&job, request.priority);
    }
    let deadline = request.deadline_ms;
    let emitter: Option<ChunkSink> = if request.stream {
        let app = app.clone();
        let job_id = job.clone();
        Some(Box::new(move |text: &str| {
            let _ = app.emit("intel-chunk", serde_json::json!({ "job": job_id, "text": text }));
        }))
    } else {
        None
    };
    let encoded = serde_json::to_string(&request).map_err(|err| IntelError::new("bad-request", err.to_string()))?;
    let work = async move {
        let raw = tauri::async_runtime::spawn_blocking(move || apple::generate(&encoded, emitter))
            .await
            .map_err(|err| IntelError::new("other", err.to_string()))?;
        decode_answer(&raw)
    };
    let outcome = bounded(&job, deadline.saturating_add(GRACE_MS), work, apple::cancel).await;
    if let Ok(mut gate) = state.gate.lock() {
        gate.finished(&job);
        if gate.was_preempted(&job) {
            if let Err(err) = &outcome {
                if err.code == "cancelled" || err.code == "timeout" {
                    return Err(IntelError::new("preempted", "a request from the user took the slot"));
                }
            }
        }
    }
    outcome
}

#[tauri::command]
pub async fn intel_cancel(job: String) {
    tauri::async_runtime::spawn_blocking(move || apple::cancel(&job)).await.ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_serializes_in_the_shape_the_shim_reads() {
        let request = GenerateRequest {
            job: "j1".into(),
            model: "system".into(),
            instructions: "Read documents.".into(),
            prompt: "Summarize.".into(),
            schema: None,
            stream: false,
            max_tokens: 200,
            temperature: 0.2,
            deadline_ms: 8000,
            priority: Priority::Interactive,
        };
        let json: serde_json::Value = serde_json::to_value(&request).unwrap();
        assert_eq!(json["job"], "j1");
        assert_eq!(json["maxTokens"], 200);
        assert_eq!(json["deadlineMs"], 8000);
        assert_eq!(json["priority"], "interactive");
        assert!(json.get("schema").is_none(), "an absent schema is omitted, not null");
        let back: GenerateRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, request);
    }

    #[test]
    fn the_shim_answer_becomes_a_value_or_a_typed_error() {
        let ok = decode_answer(r#"{"ok":{"summary":"x","tags":["a"]}}"#).unwrap();
        assert_eq!(ok["summary"], "x");
        let err = decode_answer(r#"{"error":"guardrail","detail":"declined"}"#).unwrap_err();
        assert_eq!(err.code, "guardrail");
        assert_eq!(err.detail, "declined");
        let unknown = decode_answer(r#"{"error":"something-new"}"#).unwrap_err();
        assert_eq!(unknown.code, "other");
        assert_eq!(unknown.detail, "something-new");
        let garbage = decode_answer("not json").unwrap_err();
        assert_eq!(garbage.code, "other");
    }

    #[test]
    fn availability_json_is_passed_through_and_malformed_reads_as_absent() {
        let state = decode_availability(r#"{"state":"available","contextSize":4096}"#);
        assert_eq!(state["state"], "available");
        assert_eq!(state["contextSize"], 4096);
        let absent = decode_availability("");
        assert_eq!(absent["state"], "unavailable");
        assert_eq!(absent["reason"], "build-without-sdk");
    }

    #[test]
    fn an_interactive_request_preempts_a_running_background_job() {
        let mut gate = Gate::default();
        assert_eq!(gate.admit("bg", Priority::Background), Admission::Start);
        gate.started("bg", Priority::Background);
        assert_eq!(
            gate.admit("search", Priority::Interactive),
            Admission::Preempt { cancel: "bg".to_string() }
        );
        // The background caller learns it was preempted, not cancelled.
        assert!(gate.was_preempted("bg"));
        gate.finished("bg");
        assert_eq!(gate.admit("search", Priority::Interactive), Admission::Start);
    }

    #[test]
    fn interactive_requests_wait_for_each_other_and_background_waits_for_all() {
        let mut gate = Gate::default();
        gate.started("ask", Priority::Interactive);
        assert_eq!(gate.admit("search", Priority::Interactive), Admission::Wait);
        assert_eq!(gate.admit("bg", Priority::Background), Admission::Wait);
        gate.finished("ask");
        assert_eq!(gate.admit("bg", Priority::Background), Admission::Start);
    }

    #[test]
    fn a_job_that_outlives_its_deadline_is_cancelled_and_reported_as_timeout() {
        let cancelled = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = cancelled.clone();
        let outcome = tauri::async_runtime::block_on(bounded(
            "slow",
            50,
            async {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                Ok(serde_json::json!({"ok": true}))
            },
            move |job| seen.lock().unwrap().push(job.to_string()),
        ));
        let err = outcome.unwrap_err();
        assert_eq!(err.code, "timeout");
        assert_eq!(cancelled.lock().unwrap().as_slice(), ["slow"]);
    }

    /// The whole bridge against the real model on this Mac. Ignored by
    /// default because it needs macOS 26 with Apple Intelligence on; run
    /// it by name when checking a shell build:
    /// `cargo test -p engram-store-desktop -- --ignored live_shim`.
    #[test]
    #[ignore]
    fn live_shim_answers_in_the_requested_shape() {
        let state = decode_availability(&apple::availability());
        assert_eq!(state["state"], "available", "assistant not available here: {state}");
        let request = GenerateRequest {
            job: "live-1".into(),
            model: "system".into(),
            instructions: "Answer with the requested structure only.".into(),
            prompt: "Name one everyday object and its color.".into(),
            schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "object": { "type": "string", "description": "the object" },
                    "color": { "type": "string", "enum": ["red", "green", "blue", "other"] }
                },
                "required": ["object", "color"],
                "order": ["object", "color"]
            })),
            stream: false,
            max_tokens: 60,
            temperature: 0.2,
            deadline_ms: 15_000,
            priority: Priority::Interactive,
        };
        let raw = apple::generate(&serde_json::to_string(&request).unwrap(), None);
        let answer = decode_answer(&raw).unwrap_or_else(|err| panic!("shim refused: {err:?}"));
        assert!(answer["object"].is_string(), "no object in {answer}");
        assert!(["red", "green", "blue", "other"].contains(&answer["color"].as_str().unwrap_or("")));

        // A nested shape: an array of objects with an enum inside, the form
        // the document reading uses for dates.
        let nested = GenerateRequest {
            job: "live-1b".into(),
            prompt: "The policy expires on 2026-10-05 and the premium of 412.50 is due on 2025-09-30.".into(),
            schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "facts": {
                        "type": "array",
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": { "type": "string", "enum": ["expiry", "due", "amount"] },
                                "value": { "type": "string", "description": "YYYY-MM-DD or a decimal" }
                            },
                            "required": ["kind", "value"],
                            "order": ["kind", "value"]
                        }
                    }
                },
                "required": ["facts"],
                "order": ["facts"]
            })),
            // Structured answers need room: a cap that fits one word
            // truncates the JSON and the framework cannot decode it.
            max_tokens: 400,
            ..request.clone()
        };
        let raw = apple::generate(&serde_json::to_string(&nested).unwrap(), None);
        let answer = decode_answer(&raw).unwrap_or_else(|err| panic!("shim refused nested: {err:?}"));
        let facts = answer["facts"].as_array().expect("facts array");
        assert!(!facts.is_empty(), "no facts in {answer}");
        assert!(facts.iter().all(|f| ["expiry", "due", "amount"].contains(&f["kind"].as_str().unwrap_or(""))));

        // A plain streamed answer arrives as cumulative chunks and ends
        // with the same text the call returns.
        let chunks = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = chunks.clone();
        let streamed = GenerateRequest {
            job: "live-2".into(),
            schema: None,
            stream: true,
            prompt: "In five words, what is a hammer for?".into(),
            ..request
        };
        let raw = apple::generate(
            &serde_json::to_string(&streamed).unwrap(),
            Some(Box::new(move |text| seen.lock().unwrap().push(text.to_string()))),
        );
        let answer = decode_answer(&raw).unwrap_or_else(|err| panic!("shim refused: {err:?}"));
        let text = answer.as_str().unwrap_or("").to_string();
        assert!(!text.is_empty());
        let chunks = chunks.lock().unwrap();
        assert!(!chunks.is_empty(), "no chunks arrived");
        assert_eq!(chunks.last().unwrap(), &text);

        // A cancelled job answers "cancelled", not a hang.
        let slow = GenerateRequest { job: "live-3".into(), prompt: "Write a long story.".into(), ..streamed };
        let encoded = serde_json::to_string(&slow).unwrap();
        let handle = std::thread::spawn(move || apple::generate(&encoded, None));
        std::thread::sleep(std::time::Duration::from_millis(300));
        apple::cancel("live-3");
        let raw = handle.join().unwrap();
        let err = decode_answer(&raw).unwrap_err();
        assert_eq!(err.code, "cancelled", "got {raw}");
    }

    #[test]
    fn a_job_inside_its_deadline_returns_its_value() {
        let outcome = tauri::async_runtime::block_on(bounded(
            "fast",
            5000,
            async { Ok(serde_json::json!({"ok": 1})) },
            |_| panic!("nothing to cancel"),
        ));
        assert_eq!(outcome.unwrap()["ok"], 1);
    }
}
