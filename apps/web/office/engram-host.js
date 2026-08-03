/* eslint-disable */
/**
 * The sandboxed host: everything between the app and the office editor.
 *
 * This document is framed with the sandbox attribute and without
 * allow-same-origin, so it runs in an opaque origin. It cannot reach the
 * page that holds the master key, that page's storage, its cookies or its
 * session, and it cannot make a credentialed request. What it can do is
 * exchange messages with the app and run the editor, which is all it needs.
 *
 * The app sends a document already converted to the editor's internal
 * format, along with any images the conversion extracted. Conversion itself
 * happens on the app's own origin, where the engine can be cached; see
 * public/x2t-worker.js for why.
 *
 * The editor lives in a further frame, which is a second and distinct
 * opaque origin. That has two consequences worth knowing before changing
 * anything here:
 *
 *   - A blob: URL cannot cross between them, because such a URL is readable
 *     only by the origin that created it. Bytes travel as data: URLs.
 *   - No property of the editor frame can be read directly; every call into
 *     the editor is a message answered by the shim loaded inside it.
 */

var MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  webp: "image/webp",
  emf: "image/emf",
  wmf: "image/wmf",
};

var state = { media: {}, editor: null, fileType: "docx" };

function toBase64(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

function dataUrl(bytes, mime) {
  return "data:" + (mime || "application/octet-stream") + ";base64," + toBase64(bytes);
}

function toApp(message, transfer) {
  parent.postMessage(message, "*", transfer || []);
}

/** Calls into the editor frame, which only the shim there can reach. */
var rpcSeq = 0;
var rpcPending = {};
function editorCall(method, arg) {
  return new Promise(function (resolve, reject) {
    var id = ++rpcSeq;
    rpcPending[id] = { resolve: resolve, reject: reject };
    window.frames[0].postMessage({ t: "engramEditorRpc", id: id, method: method, arg: arg }, "*");
    setTimeout(function () {
      if (rpcPending[id]) {
        delete rpcPending[id];
        reject(new Error("the editor stopped responding"));
      }
    }, 60000);
  });
}

window.addEventListener("message", function (event) {
  var data = event.data;
  if (!data) {
    return;
  }

  // Replies from the editor frame.
  if (data.t === "engramEditorRpcResult" && rpcPending[data.id]) {
    var waiting = rpcPending[data.id];
    delete rpcPending[data.id];
    if (data.error) {
      waiting.reject(new Error(data.error));
    } else {
      waiting.resolve(data.value);
    }
    return;
  }

  // A shortcut pressed inside the editor, which the app cannot see.
  if (data.t === "engramShortcut") {
    toApp({ t: "shortcut", name: data.name });
    return;
  }

  // The editor asking us for something. Only images are on the open path,
  // and they must be inlined: this frame's blob: URLs are unreadable there.
  if (data.t === "engramAppRpc") {
    var value = "";
    if (data.method === "getImageURL") {
      var name = String(data.arg).split("/").pop().split("?")[0];
      var bytes = state.media[name];
      if (bytes) {
        var ext = name.split(".").pop().toLowerCase();
        value = dataUrl(bytes, MIME_BY_EXT[ext]);
      }
    }
    event.source.postMessage({ t: "engramAppRpcResult", id: data.id, value: value }, "*");
    return;
  }

  if (data.t === "open") {
    open(data).catch(function (err) {
      toApp({ t: "failed", error: String((err && err.message) || err) });
    });
    return;
  }

  if (data.t === "save") {
    // The editor returns its document as base64 in the internal format; the
    // app converts it back to a real file, where the converter lives.
    editorCall("save").then(
      function (bin) {
        toApp({ t: "saved", id: data.id, bin: bin });
      },
      function (err) {
        toApp({ t: "saved", id: data.id, error: String((err && err.message) || err) });
      },
    );
  }
});

function loadEditorApi() {
  return new Promise(function (resolve, reject) {
    var script = document.createElement("script");
    script.src = "/office/web-apps/apps/api/documents/api.js";
    script.onload = resolve;
    script.onerror = function () {
      reject(new Error("the editor could not be loaded"));
    };
    document.body.appendChild(script);
  });
}

function open(request) {
  state.media = request.media || {};
  state.fileType = request.fileType;
  return loadEditorApi().then(function () {
    var isSheet = request.fileType === "xlsx";
    var editor = new window.DocsAPI.DocEditor("editor", {
      // Explicit, because the vendored build replaces DocsAPI.DocEditor with
      // its own class: the original constructor then reads defaultConfig off
      // that wrapper, finds none, and drops every default including these.
      // Without them the editor frame renders at 300x150 in a corner.
      width: "100%",
      height: "100%",
      document: {
        fileType: request.fileType,
        key: "local",
        title: request.title || "document." + request.fileType,
        url: dataUrl(new Uint8Array(request.bin)),
        permissions: { print: true, download: false },
      },
      documentType: isSheet ? "cell" : "word",
      editorConfig: {
        lang: "en",
        mode: "edit",
        user: { id: "0", firstname: "you", name: "you" },
        customization: {
          compactHeader: true,
          chat: false,
          comments: false,
          hideRightMenu: true,
          features: { spellcheck: false },
        },
      },
      events: {
        onAppReady: function () {
          toApp({ t: "progress", stage: "loading" });
        },
        onDocumentReady: function () {
          toApp({ t: "ready" });
        },
        onDocumentStateChange: function (event) {
          toApp({ t: "changed", modified: !!(event && event.data) });
        },
        onError: function (event) {
          var detail = event && event.data ? event.data.errorDescription : "";
          toApp({ t: "failed", error: detail || "the editor reported an error" });
        },
      },
    });
    state.editor = editor;
    // The editor API hangs its host callbacks off this object and does not
    // create it; without it, connecting the stand-in server throws.
    window.APP = window.APP || {};

    // Standing in for the collaboration server the editor expects. Nothing
    // here goes near a network: a single local participant, no history, and
    // the lock handshakes answered immediately so saving can complete.
    editor.connectMockServer({
      getParticipants: function () {
        return {
          list: [
            { id: "0", idOriginal: "0", username: "you", indexUser: 0, connectionId: "local" },
          ],
          index: 0,
        };
      },
      getInitialChanges: function () {
        return [];
      },
      getImageURL: function () {
        return Promise.resolve("");
      },
      onAuth: function () {},
      onMessage: function (message) {
        if (message.type === "isSaveLock") {
          editor.sendMessageToOO({ type: "saveLock", saveLock: false });
        } else if (message.type === "getLock") {
          editor.sendMessageToOO({ type: "getLock", locks: {} });
        } else if (message.type === "saveChanges") {
          editor.sendMessageToOO({ type: "unSaveLock", index: 0, time: Date.now() });
        } else if (message.type === "unLockDocument" && message.isSave) {
          editor.sendMessageToOO({ type: "unSaveLock", time: -1, index: -1 });
        } else if (message.type === "getMessages") {
          editor.sendMessageToOO({ type: "message" });
        }
      },
    });
  });
}

toApp({ t: "hello" });
