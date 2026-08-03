/* eslint-disable */
/**
 * Document format conversion, off the main thread and on this app's own
 * origin.
 *
 * The converter is the OnlyOffice x2t engine compiled to WebAssembly. It
 * translates .docx and .xlsx to the internal format the editor edits, and
 * back again, and it is the only part of the office feature that touches
 * document bytes outside the editor frame.
 *
 * It lives here, rather than inside the sandboxed editor frame, for three
 * reasons:
 *
 *   1. Caching. The editor frame runs in an opaque origin, which has no
 *      usable HTTP cache, so anything it loads is re-fetched on every
 *      document open. This worker is same-origin, so the 9MB engine is
 *      fetched once and revalidated cheaply thereafter.
 *   2. Permissions. The engine needs nothing the app's own strict policy
 *      does not already grant; only the editor requires relaxed script
 *      permissions. Keeping the two apart means the relaxed policy covers
 *      as little code as possible.
 *   3. Isolation. The engine installs around twenty globals, so it wants
 *      its own realm. A worker gives it one, the same arrangement the
 *      on-device OCR engine uses.
 *
 * The working directory persists for the life of the worker, which matters
 * on save: importing a document extracts its images to /working/media, and
 * exporting reads them back from there. A worker discarded between open and
 * save would silently drop every image in the document.
 */

const ENGINE_SCRIPT = "/office/x2t/x2t.js";
const ENGINE_WASM = "/office/x2t/x2t.wasm";

let engine = null;
let ready = null;

/** Loads the engine once; later calls share the first load. */
function load() {
  if (ready) {
    return ready;
  }
  ready = (async () => {
    // Fetch the engine ourselves rather than letting it resolve its own
    // path: it would resolve relative to this worker's location, which is
    // not where the engine lives. Fetching it here also puts it in the
    // ordinary HTTP cache, which is the whole reason conversion runs on
    // this origin instead of inside the editor's frame.
    const response = await fetch(ENGINE_WASM);
    if (!response.ok) {
      throw new Error(`converter unavailable (${response.status})`);
    }
    const wasmBinary = new Uint8Array(await response.arrayBuffer());
    return new Promise((resolve, reject) => {
      self.Module = {
        wasmBinary,
        onRuntimeInitialized() {
          resolve(self.Module);
        },
        onAbort(reason) {
          reject(new Error(`converter failed to start: ${reason}`));
        },
      };
      try {
        self.importScripts(ENGINE_SCRIPT);
      } catch (err) {
        reject(err);
      }
    });
  })().then((module) => {
    engine = module;
    for (const dir of ["/working", "/working/media", "/working/fonts", "/working/themes"]) {
      if (!engine.FS.analyzePath(dir).exists) {
        engine.FS.mkdir(dir);
      }
    }
    return engine;
  });
  return ready;
}

/**
 * Runs one conversion. The engine is driven by a parameters file rather
 * than arguments, and reports failure through a return code.
 */
function convert(inputName, outputName) {
  const params =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<m_sFileFrom>/working/${inputName}</m_sFileFrom>` +
    `<m_sFileTo>/working/${outputName}</m_sFileTo>` +
    "<m_bIsNoBase64>false</m_bIsNoBase64>" +
    "<m_sThemeDir>/working/themes</m_sThemeDir>" +
    "<m_sFontDir>/working/fonts</m_sFontDir>" +
    "</TaskQueueDataConvert>";
  engine.FS.writeFile("/working/params.xml", params);
  const code = engine.ccall("main1", "number", ["string"], ["/working/params.xml"]);
  if (code !== 0) {
    throw new Error(`conversion failed (${code})`);
  }
  return engine.FS.readFile(`/working/${outputName}`, { encoding: "binary" });
}

/** Every file the importer extracted, which the editor asks for by name. */
function readMedia() {
  const media = {};
  if (!engine.FS.analyzePath("/working/media").exists) {
    return media;
  }
  for (const name of engine.FS.readdir("/working/media")) {
    if (name === "." || name === "..") {
      continue;
    }
    try {
      media[name] = engine.FS.readFile(`/working/media/${name}`, { encoding: "binary" });
    } catch {
      // A directory or an unreadable entry is not media; skip it.
    }
  }
  return media;
}

self.onmessage = async (event) => {
  const { id, op, name, bytes } = event.data ?? {};
  try {
    await load();
    if (op === "import") {
      // The extension decides the parser, so the name has to survive.
      engine.FS.writeFile(`/working/${name}`, bytes);
      const bin = convert(name, `${name}.bin`);
      const media = readMedia();
      const transfer = [bin.buffer, ...Object.values(media).map((m) => m.buffer)];
      self.postMessage({ id, bin, media }, transfer);
      return;
    }
    if (op === "export") {
      engine.FS.writeFile("/working/save.bin", bytes);
      const out = convert("save.bin", name);
      self.postMessage({ id, bytes: out }, [out.buffer]);
      return;
    }
    throw new Error(`unknown operation ${op}`);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
