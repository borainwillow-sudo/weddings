(function () {
  var DRAFT_KEY = "wb_draft";
  var AUTH_KEY = "wb_auth";
  var EDITING_KEY = "wb_editing";
  var EDITOR_SHOWN_KEY = "wb_editor_shown";
  var PENDING_KEY = "wb_pending_photos";

  // Photos that have been processed in the browser but not yet committed.
  // Held as Blobs in IndexedDB (not localStorage, which is far too small and
  // string-only) so that staged work survives a reload or a crash.
  var pendingPhotos = {};
  var DB_NAME = "wb_photos";
  var STORE = "pending";
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () {
          resolve(out && out.result !== undefined ? out.result : out);
        };
        t.onerror = function () {
          reject(t.error);
        };
      });
    });
  }

  async function idbPut(record) {
    return tx("readwrite", function (s) {
      return s.put(record);
    });
  }

  async function idbGetAll() {
    return tx("readonly", function (s) {
      return s.getAll();
    });
  }

  async function idbClear() {
    return tx("readwrite", function (s) {
      return s.clear();
    });
  }

  // Rehydrates anything staged in a previous session so its images still
  // render (and can still be published) after a reload.
  async function initPending() {
    try {
      var records = await idbGetAll();
      (records || []).forEach(function (r) {
        pendingPhotos[r.id] = normalizeRecord(r);
      });
      return Object.keys(pendingPhotos).length;
    } catch (e) {
      return 0;
    }
  }

  async function loadPublished() {
    try {
      var res = await fetch("data.json", { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      return await res.json();
    } catch (e) {
      return JSON.parse(JSON.stringify(window.WB.DEFAULT_DATA));
    }
  }

  function loadDraft() {
    var raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function saveDraft(data) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearDraft() {
    localStorage.removeItem(DRAFT_KEY);
  }

  async function getData() {
    return loadDraft() || (await loadPublished());
  }

  // A staged record is { id, files: [{ path, blob }] }. Photos contribute two
  // files (display + thumbnail), the cursor contributes one. Records written
  // by an earlier version used displayPath/thumbPath, so those are folded into
  // the same shape on read.
  function normalizeRecord(r) {
    if (r.files) return r;
    var files = [];
    if (r.displayPath) files.push({ path: r.displayPath, blob: r.displayBlob });
    if (r.thumbPath) files.push({ path: r.thumbPath, blob: r.thumbBlob });
    return { id: r.id, files: files };
  }

  // Returns false if the files could only be held in memory. That still works
  // for this session, but they'd be lost on reload, so the caller warns rather
  // than letting it pass unnoticed.
  async function addPendingFiles(id, files) {
    var record = { id: id, files: files };
    pendingPhotos[id] = record;
    try {
      await idbPut(record);
      return true;
    } catch (e) {
      console.warn("Could not stage files to IndexedDB:", e);
      return false;
    }
  }

  function hasPending(id) {
    return !!pendingPhotos[id];
  }

  function addPendingPhoto(processed) {
    return addPendingFiles(processed.id, [
      { path: processed.displayPath, blob: processed.displayBlob },
      { path: processed.thumbPath, blob: processed.thumbBlob },
    ]);
  }

  function getPendingPhotos() {
    return Object.keys(pendingPhotos).map(function (k) {
      return pendingPhotos[k];
    });
  }

  // Clears only the records named in `ids`. A save uploads a snapshot of
  // what was staged when it started; anything added while it was running must
  // survive, or data.json would reference files that never got published.
  // Called with no argument it clears everything.
  async function clearPendingPhotos(ids) {
    var keys = ids || Object.keys(pendingPhotos);
    keys.forEach(function (k) {
      var rec = pendingPhotos[k];
      if (!rec) return;
      (rec.files || []).forEach(function (f) {
        if (f.objectUrl) URL.revokeObjectURL(f.objectUrl);
      });
      delete pendingPhotos[k];
    });
    try {
      if (ids) {
        await tx("readwrite", function (s) {
          ids.forEach(function (k) {
            s.delete(k);
          });
        });
      } else {
        await idbClear();
      }
    } catch (e) {}
  }

  function pendingCount() {
    return Object.keys(pendingPhotos).length;
  }

  function pendingPhotoUrl(path) {
    var found = null;
    Object.keys(pendingPhotos).forEach(function (k) {
      (pendingPhotos[k].files || []).forEach(function (f) {
        if (f.path !== path) return;
        if (!f.objectUrl) f.objectUrl = URL.createObjectURL(f.blob);
        found = f.objectUrl;
      });
    });
    return found;
  }

  // Resolves a stored path to something the browser can render right now:
  // an in-memory blob for not-yet-committed photos, otherwise the real file.
  function resolveSrc(path) {
    if (!path) return null;
    return pendingPhotoUrl(path) || path;
  }

  function downloadJSON(filename, obj) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function hashPw(pw) {
    var enc = new TextEncoder().encode(pw);
    var buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
      .map(function (b) {
        return b.toString(16).padStart(2, "0");
      })
      .join("");
  }

  function getAuth() {
    var raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  async function setPassword(pw) {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ hash: await hashPw(pw) }));
  }

  async function verifyPassword(pw) {
    var auth = getAuth();
    if (!auth) return false;
    return (await hashPw(pw)) === auth.hash;
  }

  function isEditing() {
    return localStorage.getItem(EDITING_KEY) === "true";
  }

  function setEditing(v) {
    localStorage.setItem(EDITING_KEY, v ? "true" : "false");
  }

  // Whether this browser shows the Edit site button at all. Off everywhere by
  // default, so a visitor sees a plain portfolio; turned on for a device by
  // loading the site once with ?edit on the address, and off again with
  // ?edit=off. Remembered per browser, like the password and the token.
  //
  // A convenience, not a lock: the site is public and this file can be read by
  // anyone. Publishing needs the GitHub token, which never leaves this device.
  function readEditorShown() {
    var q = new URLSearchParams(location.search);
    if (q.has("edit")) {
      var on = q.get("edit") !== "off";
      localStorage.setItem(EDITOR_SHOWN_KEY, on ? "true" : "false");
      // Take it back out of the address bar so it isn't carried into a
      // bookmark that gets shared, or left showing over someone's shoulder.
      if (history.replaceState) {
        q.delete("edit");
        var rest = q.toString();
        history.replaceState(
          null,
          "",
          location.pathname + (rest ? "?" + rest : "") + location.hash
        );
      }
    }
    return localStorage.getItem(EDITOR_SHOWN_KEY) === "true";
  }

  var editorShownValue = readEditorShown();

  function editorShown() {
    return editorShownValue;
  }

  window.WB = window.WB || {};
  Object.assign(window.WB, {
    getData: getData,
    loadPublished: loadPublished,
    saveDraft: saveDraft,
    clearDraft: clearDraft,
    downloadJSON: downloadJSON,
    setPassword: setPassword,
    verifyPassword: verifyPassword,
    getAuth: getAuth,
    isEditing: isEditing,
    setEditing: setEditing,
    editorShown: editorShown,
    addPendingPhoto: addPendingPhoto,
    addPendingFiles: addPendingFiles,
    hasPending: hasPending,
    getPendingPhotos: getPendingPhotos,
    clearPendingPhotos: clearPendingPhotos,
    pendingCount: pendingCount,
    initPending: initPending,
    resolveSrc: resolveSrc,
  });
})();
