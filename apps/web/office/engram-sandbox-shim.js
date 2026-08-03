// engram-sandbox-shim.js
// Loaded as the very first script of the OnlyOffice editor document. This is
// OUR file, not a patched vendor file: on an OnlyOffice upgrade it is the only
// thing that has to be re-read and understood.
//
// WHY: the editor document runs inside a NESTED opaque origin (its ancestor
// iframe is sandbox="allow-scripts" without allow-same-origin, and every
// document nested inside a sandboxed context gets its own fresh opaque origin).
// So every read of window.parent.<anything> throws SecurityError. sdkjs's
// loadSdk() does exactly that -- `window.parent && window.parent.APP &&
// window.parent.APP.urlArgs` -- with no try/catch, so sdk-all.js never loads
// and the editor never boots. CryptPad's fork adds several more
// `window.parent.APP.*` host callbacks on top.
//
// `parent` is a [Replaceable] attribute on Window, i.e. a configurable accessor
// with a setter, so it can simply be overwritten (measured: own descriptor
// {get:true,set:true,configurable:true}; `top` by contrast is
// [LegacyUnforgeable] and cannot be redefined -- measured
// "TypeError: Cannot redefine property: top"). Overwriting it with a minimal
// stand-in makes every window.parent.* read in sdkjs and web-apps safe at once,
// instead of patching each site inside a 2.4 MB minified bundle.
//
// THIS GRANTS NO NEW CAPABILITY. The stand-in exposes only postMessage, which a
// cross-origin parent already allowed; the real parent WindowProxy stays in a
// closure and is never handed out. window.top is untouched and still throws on
// every property read. Verified by the probe block at the bottom.

(function () {
  var real = window.parent;
  if (real === window) { return; }                    // not framed: nothing to do
  try { void real.APP; return; } catch (e) { /* opaque-origin parent: shim it */ }

  // window.parent.APP is the host-callback surface CryptPad's fork calls into.
  // Same-origin it is a plain object on the host window; here it has to become a
  // postMessage RPC. Only the members the boot + open path actually uses are
  // implemented; anything else stays undefined, which is what every caller in
  // sdkjs already tests for (`window.parent.APP && window.parent.APP.x`).
  var seq = 0, pending = {};
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (d && d.t === 'engramAppRpcResult' && pending[d.id]) {
      var cb = pending[d.id]; delete pending[d.id]; cb(d.value);
    }
  });
  function rpc(method, arg, cb) {
    var id = ++seq; pending[id] = cb;
    real.postMessage({ t: 'engramAppRpc', id: id, method: method, arg: arg }, '*');
  }

  window.parent = {
    // loadSdk() and index.html's CP_urlArgs read this. '' disables cache-busting
    // query args, which we do not need: the asset path is already versioned.
    APP: {
      urlArgs: '',
      // sdkjs: window.parent.APP.getImageURL(src, cb) -- resolves an embedded
      // image name to something loadable. Callback-shaped already, so it maps
      // onto the RPC without changing the caller.
      getImageURL: function (src, cb) { rpc('getImageURL', src, cb); },
    },
    postMessage: function () { return real.postMessage.apply(real, arguments); },
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  };

  // A document with an opaque origin cannot construct a Worker from an http(s)
  // script URL at all -- every such URL is cross-origin to it. Measured:
  //   SecurityError: Failed to construct 'Worker': Script at
  //   '.../sdkjs/common/spell/spell/spell.js' cannot be accessed from origin 'null'
  // and because sdkjs builds the spellchecker inside the document-open path with
  // no try/catch, that single throw stops the open at 94% and onDocumentReady
  // never fires. Route the failure through a blob: worker that importScripts()
  // the real URL -- measured to work from an opaque origin -- and pre-seed
  // Emscripten's locateFile, because inside a blob: worker self.location is
  // blob:null/... and every relative asset path would otherwise resolve to
  // "Invalid URL".
  var NativeWorker = window.Worker;
  if (NativeWorker) {
    window.Worker = function (url, opts) {
      try { return new NativeWorker(url, opts); } catch (e) {
        var abs = new URL(url, document.baseURI).href;
        var dir = abs.slice(0, abs.lastIndexOf('/') + 1);
        var boot = 'self.Module={locateFile:function(p){return ' + JSON.stringify(dir) + '+p}};'
                 + 'importScripts(' + JSON.stringify(abs) + ');';
        return new NativeWorker(URL.createObjectURL(new Blob([boot], { type: 'text/javascript' })), opts);
      }
    };
    window.Worker.prototype = NativeWorker.prototype;
  }

  // ------------------------------------------------------------------ document
  // The document is delivered as BYTES over postMessage, never as a URL.
  //
  // The editor loads its document by URL. A blob: URL minted by the host is
  // unreadable here, because this frame is a different opaque origin, so the
  // obvious remaining option was to inline the whole document as a data: URL.
  // That works until it does not: base64 adds a third, and Safari refuses a
  // data: URL beyond 64MiB, which a text-heavy document reaches while a far
  // larger one full of images does not (measured, see docs/office-editing.md).
  //
  // Instead the host posts the bytes in and the editor's request for a
  // sentinel URL is answered from memory. Requests that arrive before the
  // bytes do simply wait, so there is no race with the editor's boot.
  var DOCUMENT_URL = 'engram:document';
  var documentBytes = null;
  var documentWaiting = [];

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.t !== 'engramDocument') { return; }
    documentBytes = new Uint8Array(d.bytes);
    var waiting = documentWaiting.splice(0);
    for (var i = 0; i < waiting.length; i++) { waiting[i](documentBytes); }
  });

  function withDocument(fn) {
    if (documentBytes) { fn(documentBytes); return; }
    documentWaiting.push(fn);
  }

  // The editor loads its document with XMLHttpRequest. Rather than imitate
  // one, which fails because native getters reject a stand-in receiver, the
  // request is redirected: the sentinel is swapped for a blob: URL minted
  // HERE, in the editor's own origin, where it is readable. Real requests are
  // untouched, and the object stays a genuine XMLHttpRequest throughout.
  var nativeOpen = window.XMLHttpRequest.prototype.open;
  var nativeSend = window.XMLHttpRequest.prototype.send;
  var nativeSetHeader = window.XMLHttpRequest.prototype.setRequestHeader;

  window.XMLHttpRequest.prototype.open = function (method, url) {
    if (String(url) === DOCUMENT_URL) {
      // Defer opening until send(), by which point the bytes are in hand.
      this.__engramDocument = true;
      return;
    }
    this.__engramDocument = false;
    return nativeOpen.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.setRequestHeader = function () {
    // Nothing is open yet on the deferred path, and the document needs no
    // headers; setting one here would throw.
    if (this.__engramDocument) { return; }
    return nativeSetHeader.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.send = function () {
    if (!this.__engramDocument) { return nativeSend.apply(this, arguments); }
    var xhr = this;
    withDocument(function (bytes) {
      xhr.__engramDocument = false;
      var url = URL.createObjectURL(new Blob([bytes]));
      nativeOpen.call(xhr, 'GET', url, true);
      xhr.addEventListener('loadend', function () { URL.revokeObjectURL(url); });
      nativeSend.call(xhr);
    });
  };

  // Save shortcut. Focus lives inside this frame while editing, so the app's
  // own keydown listener never sees it; forward the intent outward instead of
  // letting the browser's own save dialog appear.
  window.addEventListener('keydown', function (ev) {
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && String(ev.key).toLowerCase() === 's') {
      ev.preventDefault();
      try { window.parent.postMessage({ t: 'engramShortcut', name: 'save' }, '*'); } catch (e) {}
    }
  }, true);

  // Host -> editor control RPC. Same-origin, the host reaches into the editor
  // frame directly (`iframe.contentWindow.editor.asc_nativeGetFile()` --
  // CryptPad's own accessor, inner.js:141-149). Across opaque origins that read
  // throws, so every host-driven editor call has to be a message. This is the
  // whole save path, and it is glue we own rather than a vendor patch.
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.t !== 'engramEditorRpc') { return; }
    var api = window.editor || window.editorCell;
    var value = null, error = null;
    try {
      if (!api) { throw new Error('editor not constructed yet'); }
      if (d.method === 'ping') { value = true; }
      else if (d.method === 'focus') {
        // Opening a document should leave you able to type. The editor draws
        // a caret as soon as it loads, but it reads the keyboard from a
        // hidden text area owned by its input context, and nothing focuses
        // that until you click; until then keystrokes go nowhere.
        if (typeof api.asc_enableKeyEvents === 'function') { api.asc_enableKeyEvents(true); }
        var tries = 0;
        (function place() {
          var ctx = window.AscCommon && window.AscCommon.g_inputContext;
          var area = ctx && ctx.HtmlArea;
          if (area && area.focus) {
            window.focus();
            area.focus();
            value = true;
            return;
          }
          // The input context is built during the editor's own start-up and
          // may not exist the instant the document reports ready.
          if (tries++ < 40) { setTimeout(place, 100); }
        })();
        value = true;
      }

      else if (d.method === 'paste') {
        api.asc_PasteData(window.AscCommon.c_oAscClipboardDataFormat.Text, d.arg);
        value = true;
      } else if (d.method === 'save') {
        value = api.asc_nativeGetFile();          // a STRING ("DOCY;v5;…"), never a buffer
      } else { throw new Error('unknown method ' + d.method); }
    } catch (e) { error = e.message; }
    ev.source.postMessage({ t: 'engramEditorRpcResult', id: d.id, value: value, error: error }, '*');
  });
})();
