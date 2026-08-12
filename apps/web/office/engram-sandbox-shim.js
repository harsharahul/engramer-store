// engram-sandbox-shim.js
// Loaded as the very first script of the OnlyOffice editor document. This is
// OUR file, not a patched vendor file: on an OnlyOffice upgrade it is the only
// thing that has to be re-read and understood.
//
// The app frames this document directly with sandbox="allow-scripts" and no
// allow-same-origin, so it runs in an OPAQUE ORIGIN: it has no storage, no
// cookies, no session, and cannot reach the page that holds the master key.
// It is handed a document as bytes and hands one back. Everything below
// exists because the editor was not written for that, and because the app,
// being cross-origin, cannot reach into the editor to drive it.
//
// The editor is loaded directly rather than through the vendor's wrapper
// script, which would create a further frame. Two nested sandboxed documents
// get two DIFFERENT opaque origins and cannot reach each other, which is what
// forced the whole editor onto a second real origin before. One document
// needs no second origin at all. The protocol the wrapper used to speak now
// lives in apps/web/src/office/session.ts.

(function () {
  // On touch devices, iOS zooms the whole page when a focused input's font
  // is under 16px, and it judges the TOP-LEVEL page even when the input
  // lives in this frame. The editor's typing surface is a hidden caret
  // catcher (#area_id) that the engine styles at 8px inline and focuses on
  // nearly every tap into a paragraph or cell, so editing looked like
  // random zoom-in on the phone. The app's own 16px rule cannot reach this
  // opaque-origin document; a rule here can, and author !important beats
  // the inline style. touch-action on body also suppresses double-tap
  // zoom, which the spreadsheet stylesheet sets and the document one lacks.
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    var touchStyle = document.createElement('style');
    touchStyle.textContent =
      '#area_id { font-size: 16px !important; }\n' +
      'body { touch-action: manipulation; }';
    (document.head || document.documentElement).appendChild(touchStyle);
  }

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

  // ------------------------------------------------- document and its images
  // Both are delivered as BYTES over postMessage, never as URLs. A blob: URL
  // is readable only by the origin that made it, and this origin is opaque,
  // so a URL minted by the app would be unreadable here. Minting them HERE,
  // from bytes posted in, is what makes them readable at all.
  //
  // The document additionally cannot be inlined: base64 adds a third, and
  // Safari refuses a data: URL beyond 64MiB, which a text-heavy document
  // reaches while a far larger one full of images does not (measured, see
  // docs/office-editing.md). So the editor is given a sentinel address and
  // its request for it is answered from memory. Requests that arrive before
  // the bytes do simply wait, which is what lets the editor start loading
  // while the app is still decrypting.
  var DOCUMENT_URL = 'engram:document';
  var documentBytes = null;
  var documentWaiting = [];
  var media = {};
  var mediaUrls = {};

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.t !== 'engramDocument') { return; }
    media = d.media || {};
    documentBytes = new Uint8Array(d.bytes);
    var waiting = documentWaiting.splice(0);
    for (var i = 0; i < waiting.length; i++) { waiting[i](documentBytes); }
  });

  function withDocument(fn) {
    if (documentBytes) { fn(documentBytes); return; }
    documentWaiting.push(fn);
  }

  // The editor asks for an embedded image by the name the conversion gave it,
  // sometimes as a bare name and sometimes as a path. Cached, because it asks
  // again on every repaint.
  function imageUrl(request) {
    var name = String(request).split('/').pop().split('?')[0];
    if (mediaUrls[name]) { return mediaUrls[name]; }
    var bytes = media[name];
    if (!bytes) { return ''; }
    var mime = MIME_BY_EXT[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
    mediaUrls[name] = URL.createObjectURL(new Blob([bytes], { type: mime }));
    return mediaUrls[name];
  }

  // ------------------------------------------------------ the opaque parent
  // Every read of window.parent.<anything> throws SecurityError across
  // origins. sdkjs's loadSdk() does exactly that -- `window.parent &&
  // window.parent.APP && window.parent.APP.urlArgs` -- with no try/catch, so
  // sdk-all.js never loads and the editor never boots. CryptPad's fork adds
  // several more `window.parent.APP.*` host callbacks on top.
  //
  // `parent` is a [Replaceable] attribute on Window, i.e. a configurable
  // accessor with a setter, so it can simply be overwritten (measured: own
  // descriptor {get:true,set:true,configurable:true}; `top` by contrast is
  // [LegacyUnforgeable] and cannot be redefined -- measured "TypeError:
  // Cannot redefine property: top"). Overwriting it with a minimal stand-in
  // makes every window.parent.* read in sdkjs and web-apps safe at once,
  // instead of patching each site inside a 2.4 MB minified bundle.
  //
  // THIS GRANTS NO NEW CAPABILITY. The stand-in exposes only postMessage,
  // which a cross-origin parent already allowed; the real parent WindowProxy
  // stays in a closure and is never handed out. window.top is untouched and
  // still throws on every property read.
  var real = window.parent;
  var reachable = real === window;
  if (!reachable) {
    try { void real.APP; reachable = true; } catch (e) { /* opaque: shim it */ }
  }
  if (!reachable) {
    window.parent = {
      // window.parent.APP is the host-callback surface CryptPad's fork calls
      // into. Same-origin it is a plain object on the host window; here the
      // members the boot and open path actually use are answered locally,
      // from the bytes already posted in. Anything else stays undefined,
      // which is what every caller in sdkjs already tests for.
      APP: {
        // loadSdk() and index.html's CP_urlArgs read this. '' disables
        // cache-busting query args, which we do not need: the asset path is
        // already versioned.
        urlArgs: '',
        getImageURL: function (src, cb) { cb(imageUrl(src)); },
      },
      postMessage: function () { return real.postMessage.apply(real, arguments); },
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  }

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

  // The first keystroke, rescued.
  //
  // Safari refuses to move focus into this frame from a script. Measured in
  // real Safari: sixteen attempts over 1.6 seconds, every one leaving
  // document.activeElement on the body while the frame itself holds focus.
  // It allows the move inside a user gesture, which is why clicking into the
  // document has always worked, and why the first key pressed appears to
  // vanish: the editor spends it focusing itself and the character goes with
  // it. The editor's own focus helper is a bare element.focus(), so there is
  // no vendor path that avoids this.
  //
  // A keystroke is a gesture, so focusing here succeeds. The character is
  // then handed to the editor rather than dropped. Once the element holds
  // focus the browser delivers keys to it directly and this does nothing.
  document.addEventListener('keydown', function (ev) {
    var ctx = window.AscCommon && window.AscCommon.g_inputContext;
    var area = ctx && ctx.HtmlArea;
    if (!area || document.activeElement === area) { return; }
    area.focus();
    if (document.activeElement !== area) { return; }   // still refused; nothing to rescue
    // Only a character the browser would have inserted. Anything else the
    // editor handles from its own key handling, as it did before.
    if (ev.key && ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      area.value = ev.key;
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, true);

  // ---------------------------------------------------------------- pasting
  //
  // The engine pastes HTML by writing it into an iframe it creates
  // (CommonIframe_PasteStart), then reading that frame's document back.
  // Sandbox flags inherit into nested frames, and the sandboxed-origin flag
  // beats the child's own allow-same-origin, so inside this document that
  // frame is ANOTHER opaque origin and the read throws. The throw escapes
  // the engine's paste handler after it has already counted a long action,
  // and Paste_End(), the only decrement, never runs: nothing is pasted AND
  // every later keystroke is dropped by handlers that gate on that counter.
  // The caret keeps blinking, because the blink is a different flag.
  //
  // So the HTML path is taken over here: the clipboard is read
  // synchronously inside the event, the markup is cleaned, and the engine
  // is fed through its own asc_PasteData, with the same live-element shape
  // its IE path uses (the paste processor resolves styles through
  // ownerDocument.defaultView, so the element must be in this document).
  // The text-only and internal-copy paths end in Paste_End today and stay
  // with the vendor, byte for byte. The vendor code this compensates for
  // is asserted, not patched, by scripts/office-assets.mjs; if upstream
  // changes it, the build stops and this section must be re-read.
  var NOTICE_UNREADABLE =
    'This browser did not hand the editor the clipboard. ' +
    'Nothing was pasted, and the document is still editable.';
  var NOTICE_IMAGES_ONLY = 'Images cannot be pasted into a document yet. Nothing was inserted.';
  var NOTICE_IMAGES_STRIPPED =
    'Pasted, without the pictures. Images cannot be pasted into a document yet.';

  // What the last paste event looked like and who handled it, for the
  // pasteProbe RPC: one console round trip from the host answers both
  // "did the clipboard reach the editor" and "is the keyboard still armed".
  var lastPaste = null;

  function clipboardBase() {
    var a = window.AscCommon;
    return a && a.g_clipboardBase && a.g_clipboardBase.Api ? a.g_clipboardBase : null;
  }

  // '' means the clipboard answered and the type is absent; null means it
  // would not answer at all. The two are different branches below.
  function readClipboard(dt, type) {
    if (!dt || typeof dt.getData !== 'function') { return null; }
    try {
      var value = dt.getData(type);
      return typeof value === 'string' ? value : '';
    } catch (e) { return null; }
  }

  function clipboardImages(dt) {
    var images = [];
    try {
      var items = dt && dt.items;
      for (var i = 0; items && i < items.length; i++) {
        var item = items[i];
        if (item && item.kind === 'file' && String(item.type).indexOf('image/') === 0) {
          var file = item.getAsFile();
          if (file) { images.push(file); }
        }
      }
    } catch (e) {}
    return images;
  }

  function postNotice(kind, message) {
    try { window.parent.postMessage({ t: 'engramNotice', kind: kind, message: message }, '*'); } catch (e) {}
  }

  function refocusEditor() {
    try {
      var ctx = window.AscCommon && window.AscCommon.g_inputContext;
      if (ctx && ctx.HtmlArea && ctx.HtmlArea.focus) { ctx.HtmlArea.focus(); }
    } catch (e) {}
  }

  var pasteHostElement = null;
  function pasteHost() {
    if (!pasteHostElement || !pasteHostElement.parentNode) {
      pasteHostElement = document.createElement('div');
      pasteHostElement.id = 'engram_paste_host';
      pasteHostElement.style.cssText =
        'position:fixed;left:0;top:-10000px;width:10000px;height:100px;overflow:hidden;z-index:-1000;';
      document.body.appendChild(pasteHostElement);
    }
    return pasteHostElement;
  }

  // The vendor's own paste frame has scripts disabled; this host element
  // lives in a script-enabled document, where an inserted handler attribute
  // would fire. Parse inert (a template's content does not execute), strip
  // what could run, then mount. Styles are kept: formatting is the point.
  // A pasted <style> block is live in this document for the synchronous
  // duration of the engine's read and is cleared in the same task, so
  // nothing repaints under it.
  function sanitizeInto(host, html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var root = tpl.content;
    var bad = root.querySelectorAll('script,iframe,frame,object,embed,link');
    for (var i = 0; i < bad.length; i++) { bad[i].parentNode.removeChild(bad[i]); }
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      for (var k = el.attributes.length - 1; k >= 0; k--) {
        var name = el.attributes[k].name;
        var value = el.attributes[k].value;
        if (name.slice(0, 2).toLowerCase() === 'on') { el.removeAttribute(name); continue; }
        if ((name === 'href' || name === 'src' || name === 'xlink:href') &&
            /^\s*(javascript:|data:text\/html)/i.test(value)) {
          el.removeAttribute(name);
        }
      }
    }
    host.appendChild(root);
  }

  // Word, Excel and PowerPoint announce themselves through a ProgId meta;
  // the engine's paste processor changes behavior on it (list handling,
  // table handling), so the takeover keeps the announcement.
  function pastedFromOf(host) {
    try {
      var from = window.AscCommon.c_oClipboardPastedFrom;
      var metas = host.getElementsByTagName('meta');
      for (var i = 0; i < metas.length; i++) {
        if ((metas[i].getAttribute('name') || '') !== 'ProgId') { continue; }
        var content = metas[i].getAttribute('content') || '';
        if (content.indexOf('Word') !== -1) { return from.Word; }
        if (content.indexOf('Excel') !== -1) { return from.Excel; }
        if (content.indexOf('PowerPoint') !== -1) { return from.PowerPoint; }
      }
    } catch (e) {}
    return null;
  }

  function stripImages(html) { return html.replace(/<img[^>]*>/gi, ''); }

  // The spreadsheet never calls the completion callback from its
  // cell-edit paste: g_clipboardExcel.pasteData stores the callback, but
  // the in-cell branches end with g_specialPasteHelper.Paste_Process_End()
  // alone, which does not touch the counter. Only the grid-mode branch is
  // callback-wired, which is why the word editor was fine and the
  // spreadsheet wedged again. Every cell paste branch DOES reach
  // Paste_Process_End, so for the spreadsheet completion is also taken
  // from a single-shot wrapper around it: unhook first (re-entrancy),
  // the engine's own work runs, then finish. Whichever signal comes
  // first wins; finish is idempotent.
  function hookCellPasteEnd(finish) {
    if (!window.editorCell) { return null; }
    var a = window.AscCommon;
    var helper = a && a.g_specialPasteHelper;
    if (!helper || typeof helper.Paste_Process_End !== 'function') { return null; }
    var original = helper.Paste_Process_End;
    var unhooked = false;
    var unhook = function () {
      if (!unhooked) { unhooked = true; helper.Paste_Process_End = original; }
    };
    helper.Paste_Process_End = function () {
      unhook();
      var result = original.apply(this, arguments);
      finish();
      return result;
    };
    return unhook;
  }

  // One increment, one Paste_End, whatever happens in between. The counter
  // is checked for "not zero", so releasing it twice would eat a legitimate
  // long action the same way leaking it eats the keyboard; `done` makes the
  // release single-shot. The engine finishes asynchronously (fonts, layout)
  // and reports through the callback argument, exactly like the vendor's
  // own plugin paste path; the timer is for a build that never calls back,
  // where a paste that unlocks early beats a document that never types
  // again.
  function pasteThrough(run) {
    var cb = clipboardBase();
    if (!cb) { return false; }
    var api = cb.Api;
    if (api.isLongAction && api.isLongAction()) { return false; }
    var done = false;
    var watchdog = null;
    var cleanup = null;
    var unhook = null;
    var finish = function () {
      if (done) { return; }
      done = true;
      if (watchdog) { clearTimeout(watchdog); }
      if (unhook) { try { unhook(); } catch (e) {} }
      try { cb.Paste_End(); } catch (e) {}
      if (cleanup) { try { cleanup(); } catch (e) {} }
      refocusEditor();
    };
    cb.PasteFlag = true;
    api.incrementCounterLongAction();
    cb.pastedFrom = null;
    try {
      unhook = hookCellPasteEnd(finish);
      watchdog = setTimeout(finish, 15000);
      cleanup = run(cb, api, finish);
      return true;
    } catch (e) {
      finish();
      return false;
    }
  }

  function pasteHtml(html, text, images) {
    return pasteThrough(function (cb, api, finish) {
      var box = pasteHost();
      sanitizeInto(box, html);
      cb.pastedFrom = pastedFromOf(box);
      try {
        window.AscCommon.g_specialPasteHelper.specialPasteData.images =
          images && images.length ? images : null;
      } catch (e) {}
      api.asc_PasteData(
        window.AscCommon.c_oAscClipboardDataFormat.HtmlElement, box, null, text || '', undefined, finish);
      return function () { box.innerHTML = ''; };
    });
  }

  function pasteText(text) {
    return pasteThrough(function (cb, api, finish) {
      api.asc_PasteData(
        window.AscCommon.c_oAscClipboardDataFormat.Text, text, null, undefined, undefined, finish);
      return null;
    });
  }

  function suppress(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) { ev.stopImmediatePropagation(); }
  }

  // Capture phase on window: the vendor's document.onpaste is a bubble
  // handler, so every branch below decides before it can run.
  window.addEventListener('paste', function (ev) {
    var cb = clipboardBase();
    if (!cb) { return; }                     // engine not up; nothing to protect yet
    var dt = ev.clipboardData;
    var internal = readClipboard(dt, 'text/x-custom');
    var html = readClipboard(dt, 'text/html');
    var text = readClipboard(dt, 'text/plain');
    var record = {
      at: null,
      hadClipboardData: !!dt,
      types: null,
      htmlLength: html === null ? null : html.length,
      textLength: text === null ? null : text.length,
      internal: !!(internal && internal.indexOf('asc_internalData2;') === 0),
      imageCount: 0,
      handledBy: 'none',
      error: null,
    };
    try { record.at = new Date().toISOString(); } catch (e) {}
    try { record.types = dt && dt.types ? Array.prototype.slice.call(dt.types) : null; } catch (e) {}
    lastPaste = record;

    // The editor's own copy, coming back. That path works and ends in
    // Paste_End; the vendor keeps it.
    if (record.internal) { record.handledBy = 'engine'; return; }

    var images = clipboardImages(dt);
    record.imageCount = images.length;

    // A clipboard that would not answer. The vendor handler would count a
    // long action and bail without Paste_End, killing the keyboard; it
    // must never see this event.
    if (!dt || html === null || text === null) {
      suppress(ev);
      record.handledBy = 'shim';
      record.error = 'clipboard unreadable';
      postNotice('paste', NOTICE_UNREADABLE);
      refocusEditor();
      return;
    }

    // Nothing the editor can take: an empty clipboard, or image files
    // alone, which the takeover does not carry yet. Said out loud either
    // way; the silent version of this is exactly the bug being fixed.
    if (!html && !text) {
      suppress(ev);
      record.handledBy = 'shim';
      postNotice('paste', images.length ? NOTICE_IMAGES_ONLY : NOTICE_UNREADABLE);
      refocusEditor();
      return;
    }

    // Text only: the vendor's Text branch works and ends in Paste_End.
    if (!html) { record.handledBy = 'engine'; return; }

    // HTML: the broken path. Taken over.
    suppress(ev);
    record.handledBy = 'shim';
    var stripped = stripImages(html);
    var hadImages = images.length > 0 || stripped.length !== html.length;
    var probe = document.createElement('template');
    probe.innerHTML = stripped;
    var hasContent = !!(probe.content.textContent && probe.content.textContent.trim());
    if (!hasContent && !text) {
      postNotice('paste', hadImages ? NOTICE_IMAGES_ONLY : NOTICE_UNREADABLE);
      refocusEditor();
      return;
    }
    var ok = hasContent ? pasteHtml(stripped, text, images) : pasteText(text);
    if (!ok) {
      record.error = 'engine busy or not constructed';
      return;
    }
    if (hadImages) { postNotice('paste', NOTICE_IMAGES_STRIPPED); }
  }, true);

  // Save shortcut. Focus lives inside this frame while editing, so the app's
  // own keydown listener never sees it; forward the intent outward instead of
  // letting the browser's own save dialog appear.
  window.addEventListener('keydown', function (ev) {
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && String(ev.key).toLowerCase() === 's') {
      ev.preventDefault();
      try { window.parent.postMessage({ t: 'engramShortcut', name: 'save' }, '*'); } catch (e) {}
    }
  }, true);

  // App -> editor control RPC. Same-origin, a host reaches into the editor
  // frame directly (`iframe.contentWindow.editor.asc_nativeGetFile()` --
  // CryptPad's own accessor, inner.js:141-149). Across origins that read
  // throws, so every app-driven editor call has to be a message. This is the
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
        // Opening a document should leave you able to type. The editor reads
        // the keyboard from a hidden text area owned by its input context,
        // which exists only once the editor has started, so this waits for
        // the element before asking. Where the browser honours the request,
        // that is the whole story; where it does not, the keydown handler
        // further down rescues the first keystroke.
        var tries = 0;
        (function place() {
          var ctx = window.AscCommon && window.AscCommon.g_inputContext;
          var area = ctx && ctx.HtmlArea;
          if (area && area.focus) {
            window.focus();
            area.focus();
            // Order matters: the editor keeps its own flag for whether it
            // holds the keyboard, and a keypress that arrives while it is
            // false is dropped rather than queued. Setting it after the
            // element is focused is what makes the first keystroke count.
            if (typeof api.asc_enableKeyEvents === 'function') { api.asc_enableKeyEvents(true); }
            if (document.activeElement === area) {
              // Focusing the element arms a timer that wipes it half a second
              // later, to drop anything stale left behind. It is empty here,
              // and a first keystroke landing inside that window is wiped
              // along with it.
              if (!area.value && ctx && typeof ctx.onFocusInputTextEnd === 'function') {
                ctx.onFocusInputTextEnd();
              }
              return;
            }
            // Asking once is not enough: the editor takes focus back during
            // its own start-up, and the spreadsheet in particular only holds
            // it a few attempts in. Where the browser refuses outright, these
            // retries change nothing and the first keystroke is rescued
            // below, so they are bounded rather than persistent.
          }
          if (tries++ < 20) { setTimeout(place, 100); }
        })();
        value = true;
      }
      else if (d.method === 'paste') {
        // The deterministic paste driver: browser gates use it, and it is
        // where a host-mediated clipboard read would land. Same takeover,
        // same sanitizing, same counter bracket as the paste event path.
        var p = d.arg || {};
        if (typeof p === 'string') { p = { text: p }; }
        value = p.html
          ? pasteHtml(stripImages(String(p.html)), String(p.text || ''), null)
          : pasteText(String(p.text || ''));
      } else if (d.method === 'commit') {
        // Committing on its own, for the moment before a document closes:
        // an open cell holds text the document does not have yet, so nothing
        // knows there is anything to lose.
        try {
          if (typeof api.asc_closeCellEditor === 'function') { api.asc_closeCellEditor(false); }
        } catch (e) {}
        value = true;
      } else if (d.method === 'save') {
        // Whatever the editor is still holding has to be committed first, or
        // it is not in the file. A spreadsheet keeps the cell you are typing
        // in open until you leave it, and that cell is not part of the
        // document yet: type, press Save, and the text was silently dropped.
        // The argument is `cancel`, so false is what commits it.
        try {
          if (typeof api.asc_closeCellEditor === 'function') { api.asc_closeCellEditor(false); }
        } catch (e) {}
        // Likewise a composition in progress, which is how text arrives from
        // an on-screen keyboard.
        try {
          var ctx = window.AscCommon && window.AscCommon.g_inputContext;
          if (ctx && typeof ctx.externalEndCompositeInput === 'function') {
            ctx.externalEndCompositeInput();
          }
        } catch (e) {}
        value = api.asc_nativeGetFile();          // a STRING ("DOCY;v5;…"), never a buffer
      } else if (d.method === 'flushChanges') {
        // Pushes whatever the engine still holds toward the channel: commit
        // the open cell and any composition, then ask for the autosave
        // cycle that sends pending changes as a saveChanges batch. The
        // reply reports the engine's own view, so the app can tell a quiet
        // engine from one still moving.
        try {
          if (typeof api.asc_closeCellEditor === 'function') { api.asc_closeCellEditor(false); }
        } catch (e) {}
        try {
          var fctx = window.AscCommon && window.AscCommon.g_inputContext;
          if (fctx && typeof fctx.externalEndCompositeInput === 'function') {
            fctx.externalEndCompositeInput();
          }
        } catch (e) {}
        var flushed = { started: false, haveChanges: null, haveOtherChanges: null, canSave: null };
        try { flushed.started = api.asc_Save(true) === true; } catch (e) {}
        try { flushed.haveChanges = api._haveChanges ? api._haveChanges() === true : null; } catch (e) {}
        try {
          flushed.haveOtherChanges = api._haveOtherChanges ? api._haveOtherChanges() === true : null;
        } catch (e) {}
        try { flushed.canSave = api.canSave; } catch (e) {}
        value = flushed;
      } else if (d.method === 'saveAtBarrier') {
        // The exactness a content marker needs: decide quiet and serialize
        // in ONE synchronous turn, so no keystroke and no remote batch can
        // land between the check and the bytes. An engine still moving
        // returns stale instead of a serialization the marker would lie
        // about. Where a build lacks the predicates, this degrades to a
        // plain serialization, which is exactly the old behavior.
        try {
          if (typeof api.asc_closeCellEditor === 'function') { api.asc_closeCellEditor(false); }
        } catch (e) {}
        try {
          var bctx = window.AscCommon && window.AscCommon.g_inputContext;
          if (bctx && typeof bctx.externalEndCompositeInput === 'function') {
            bctx.externalEndCompositeInput();
          }
        } catch (e) {}
        var moving = false;
        try { moving = api._haveChanges ? api._haveChanges() === true : false; } catch (e) {}
        try {
          if (!moving && api._haveOtherChanges) { moving = api._haveOtherChanges() === true; }
        } catch (e) {}
        value = moving ? { stale: true } : { stale: false, bin: api.asc_nativeGetFile() };
      } else if (d.method === 'collabProbe') {
        // The engine's collaboration internals, for the diagnostics
        // panel. The frame is an opaque origin, so only this shim can
        // read them; each field guarded because builds differ.
        var probe = {};
        try {
          var ce = window.AscCommon && window.AscCommon.CollaborativeEditing;
          if (ce) {
            probe.globalLock = ce.m_bGlobalLock;
            probe.fast = ce.Is_Fast ? ce.Is_Fast() : ce.m_bFast;
            probe.useType = ce.m_nUseType;
            probe.needUnlock = ce.m_aNeedUnlock ? ce.m_aNeedUnlock.length : null;
            probe.needUnlock2 = ce.m_aNeedUnlock2 ? ce.m_aNeedUnlock2.length : null;
          }
        } catch (e) {}
        try { probe.haveChanges = api._haveChanges ? api._haveChanges() === true : null; } catch (e) {}
        try {
          probe.haveOtherChanges = api._haveOtherChanges ? api._haveOtherChanges() === true : null;
        } catch (e) {}
        try {
          var co = api.CoAuthoringApi;
          if (co) {
            probe.userId = co._userId;
            probe.canSave = api.canSave;
            probe.lockBuffer = co._lockBuffer ? co._lockBuffer.length : null;
            probe.foreignLocks = [];
            var locks = co._locks || {};
            for (var k in locks) {
              if (locks[k] && locks[k].state === 3) { probe.foreignLocks.push(k); }
            }
          }
        } catch (e) {}
        value = probe;
      } else if (d.method === 'pasteProbe') {
        // The clipboard state and the last paste seen, for real-browser
        // verification: one call answers whether the clipboard reached the
        // editor and whether the input-gating counter is clean.
        var pasteState = { lastPaste: lastPaste };
        try {
          var pcb = clipboardBase();
          pasteState.IsLongActionCurrent = pcb ? pcb.Api.IsLongActionCurrent : null;
          pasteState.isLongAction = pcb && pcb.Api.isLongAction ? pcb.Api.isLongAction() === true : null;
          pasteState.PasteFlag = pcb ? pcb.PasteFlag : null;
          pasteState.CopyFlag = pcb ? pcb.CopyFlag : null;
        } catch (e) {}
        try {
          pasteState.isSafariMacOs = !!(window.AscCommon && window.AscCommon.AscBrowser &&
            window.AscCommon.AscBrowser.isSafariMacOs);
        } catch (e) {}
        value = pasteState;
      } else { throw new Error('unknown method ' + d.method); }
    } catch (e) { error = e.message; }
    ev.source.postMessage({ t: 'engramEditorRpcResult', id: d.id, value: value, error: error }, '*');
  });
})();
