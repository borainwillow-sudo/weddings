(function () {
  // Shown at the bottom of the Style panel. Bump alongside the ?v= query
  // strings in index.html so a stale copy can be identified at a glance.
  var EDITOR_VERSION = "22";
  var data = null;
  var currentId = "home";
  var openGroups = {};
  var saveTimer = null;
  var saving = false;
  // Version counters rather than a boolean: a save publishes a snapshot, and
  // edits can land while it's uploading. Comparing what was sent against what
  // has since changed is the only way to tell "saved everything" from "saved
  // what I happened to send".
  var dirtyVersion = 0;
  var savedVersion = 0;
  // Photo ids added during this session, and those this session has since
  // published. Only the difference between them can be judged "lost".
  var sessionAddedIds = {};
  var publishedPhotoIds = {};

  function isDirty() {
    return dirtyVersion !== savedVersion;
  }

  var $ = function (id) {
    return document.getElementById(id);
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- data helpers ----------

  function allPages(d) {
    var out = [];
    (d.pages || []).forEach(function (p) {
      out.push(p);
      (p.children || []).forEach(function (c) {
        out.push(c);
      });
    });
    return out;
  }

  function findPage(d, id) {
    return allPages(d).find(function (p) {
      return p.id === id;
    });
  }

  function parentGroupOf(d, id) {
    return (d.pages || []).find(function (p) {
      return (p.children || []).some(function (c) {
        return c.id === id;
      });
    });
  }

  function firstNavigablePage(d) {
    var p = allPages(d).find(function (x) {
      return x.type !== "group";
    });
    return p ? p.id : "home";
  }

  function uniquePageId(d, base) {
    var ids = allPages(d).map(function (p) {
      return p.id;
    });
    var slug = window.WB.slugify(base) || "page";
    var candidate = slug;
    var n = 1;
    while (ids.indexOf(candidate) !== -1) {
      n++;
      candidate = slug + "-" + n;
    }
    return candidate;
  }

  // ---------- typography ----------

  // The custom cursor is deliberately not applied in edit mode, so the
  // grab/grabbing/resize cursors still communicate what's draggable.
  function applyCursor() {
    var c = data.cursor || {};
    var value = "auto";
    if (c.image) {
      var src = window.WB.resolveSrc(c.image);
      var hx = 0;
      var hy = 0;
      if (c.hotspot === "center") {
        hx = Math.round((c.width || 32) / 2);
        hy = Math.round((c.height || 32) / 2);
      }
      value = 'url("' + src + '") ' + hx + " " + hy + ", auto";
    }
    document.documentElement.style.setProperty("--site-cursor", value);
  }

  // The mobile bar's height depends on the size of the name and whether it
  // wraps onto a second line, so the menu drawer can't be positioned under it
  // with a fixed guess — it gets measured and handed to the stylesheet.
  function measureMobileBar() {
    var bar = document.querySelector(".mobile-bar");
    var h = bar ? bar.offsetHeight : 0;
    document.documentElement.style.setProperty("--mobile-bar-h", h + "px");
  }

  // On a phone, either keep the desktop arrangement (shrunk to fit) or fall
  // back to the stacked grid. Both the stylesheet and the layout engine read
  // this class.
  function applyPhoneLayout() {
    document.body.classList.toggle(
      "phone-desktop-layout",
      (data.phoneLayout || "desktop") === "desktop"
    );
  }

  // Blank space below the last photo, as a proportion of screen height.
  function applyFooterSpace() {
    var space = data.footer && typeof data.footer.space === "number"
      ? data.footer.space
      : 45;
    document.documentElement.style.setProperty("--footer-space", space + "vh");
  }

  // Drops typography keys that aren't real text roles. An earlier build wrote
  // typography["undefined"] whenever the cursor-size or end-of-page controls
  // were touched; this clears that out of existing data.
  function pruneTypography() {
    if (!data.typography) return false;
    var valid = window.WB.TYPO_ROLES.map(function (r) {
      return r.key;
    });
    var removed = false;
    Object.keys(data.typography).forEach(function (k) {
      if (valid.indexOf(k) === -1) {
        delete data.typography[k];
        removed = true;
      }
    });
    return removed;
  }

  function applyTypography() {
    var t = data.typography || {};
    window.WB.TYPO_ROLES.forEach(function (role) {
      var cfg = t[role.key];
      if (!cfg) return;
      document.documentElement.style.setProperty(
        "--f-" + role.key + "-weight",
        cfg.weight
      );
      document.documentElement.style.setProperty(
        "--f-" + role.key + "-size",
        cfg.size + "px"
      );
    });
  }

  // ---------- saving ----------

  // Problems that need to survive the next status update get their own line,
  // dismissed by the reader rather than overwritten a second later.
  function showNotice(text) {
    var el = $("edit-notice");
    el.querySelector("span").textContent = text;
    el.hidden = false;
  }

  function setStatus(text, cls) {
    var el = $("save-status");
    el.textContent = text;
    el.className = "save-status" + (cls ? " " + cls : "");
  }

  function markDirty() {
    var ok = window.WB.saveDraft(data);
    dirtyVersion++;
    if (!ok) {
      setStatus("Local draft too large — save now to publish", "is-error");
    }
    if (!window.WB.gh.hasToken()) {
      setStatus("Saved on this device — connect GitHub to publish", "");
      return;
    }
    setStatus("Unsaved changes", "");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(commit, 2500);
  }

  async function commit(opts) {
    opts = opts || {};
    if (saving) return;
    if (!window.WB.gh.hasToken()) {
      if (opts.manual) openConnect();
      return;
    }
    if (!isDirty() && !opts.manual) return;

    saving = true;
    // Everything below publishes this snapshot; anything edited after it bumps
    // dirtyVersion past it and earns another save.
    var sendingVersion = dirtyVersion;
    clearTimeout(saveTimer);
    var pending = window.WB.getPendingPhotos();
    var pendingFileCount = pending.reduce(function (n, r) {
      return n + (r.files ? r.files.length : 0);
    }, 0);
    setStatus(
      pendingFileCount ? "Saving " + pendingFileCount + " file(s)…" : "Saving…",
      "is-saving"
    );

    // Guard against publishing a reference to a file that will never exist —
    // an image that neither loads nor saves, with no way to recover it.
    //
    // Deliberately narrow: only photos added during THIS session, which
    // therefore must still have staged files unless something went wrong.
    // Anything loaded at startup is left alone, because the published
    // data.json is served from a CDN and lags a deploy by up to a minute —
    // trusting it to decide what exists would delete work that is perfectly
    // fine.
    var lost = [];
    allPages(data).forEach(function (pg) {
      if (!pg.photos) return;
      pg.photos = pg.photos.filter(function (ph) {
        if (!sessionAddedIds[ph.id]) return true;
        if (publishedPhotoIds[ph.id] || window.WB.hasPending(ph.id)) return true;
        lost.push(ph.id);
        return false;
      });
    });
    if (lost.length) {
      render();
      window.WB.saveDraft(data);
      showNotice(
        lost.length +
          " photo(s) lost their image data before saving and were removed. Please add them again."
      );
    }

    try {
      var files = [
        {
          path: "data.json",
          content: JSON.stringify(data, null, 2),
          encoding: "utf-8",
        },
      ];
      for (var i = 0; i < pending.length; i++) {
        var staged = pending[i].files || [];
        for (var j = 0; j < staged.length; j++) {
          if (!(staged[j].blob instanceof Blob)) continue;
          files.push({
            path: staged[j].path,
            content: await window.WB.blobToBase64(staged[j].blob),
            encoding: "base64",
          });
        }
      }

      // Snapshot taken before the upload; only these are cleared, so photos
      // added while it was running stay staged for the next save.
      var committedIds = pending.map(function (r) {
        return r.id;
      });

      await window.WB.gh.commitFiles(files, "Update site content");
      committedIds.forEach(function (id) {
        publishedPhotoIds[id] = true;
      });
      await window.WB.clearPendingPhotos(committedIds);
      savedVersion = sendingVersion;
      setStatus(
        isDirty() ? "Saved — more to send…" : "Saved — live in about a minute",
        "is-saved"
      );
    } catch (err) {
      setStatus(String(err.message || err), "is-error");
    } finally {
      saving = false;
      // Edits made during the upload had their debounce timer swallowed by the
      // in-flight save; without this they'd sit unpublished until some later,
      // unrelated edit happened to trigger a save.
      if (isDirty() && window.WB.gh.hasToken()) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(commit, 2500);
      }
    }
  }

  // ---------- nav ----------

  function renderNav() {
    var nav = $("nav-content");
    var html = "";
    (data.pages || []).forEach(function (page) {
      if (page.type === "group") {
        var isOpen = !!openGroups[page.id];
        html +=
          '<button class="nav-item nav-group-toggle" data-group="' +
          esc(page.id) +
          '" aria-expanded="' +
          isOpen +
          '"><span>' +
          esc(page.title) +
          "</span><span>" +
          (isOpen ? "&minus;" : "+") +
          "</span></button>";
        html += '<div class="nav-children' + (isOpen ? " open" : "") + '">';
        (page.children || []).forEach(function (child) {
          html +=
            '<a class="nav-item nav-child' +
            (child.id === currentId ? " is-active" : "") +
            '" href="#/' +
            esc(child.id) +
            '">' +
            esc(child.title) +
            "</a>";
        });
        html += "</div>";
      } else {
        html +=
          '<a class="nav-item' +
          (page.id === currentId ? " is-active" : "") +
          '" href="#/' +
          esc(page.id) +
          '">' +
          esc(page.title) +
          "</a>";
      }
    });
    nav.innerHTML = html;
  }

  // ---------- page rendering ----------

  function headerHTML(page) {
    var editing = window.WB.isEditing();
    var h = page.header || {};
    var attr = function (field) {
      return editing
        ? ' contenteditable="true" data-header-field="' + field + '"'
        : "";
    };
    var hasAny =
      h.title || h.meta || h.quote || h.description || editing;
    if (!hasAny) return "";

    var row = "";
    if (h.title || editing)
      row += '<div class="header-title"' + attr("title") + ">" + esc(h.title) + "</div>";
    if (h.meta || editing)
      row += '<div class="header-meta"' + attr("meta") + ">" + esc(h.meta) + "</div>";
    if (h.quote || editing)
      row += '<div class="header-quote"' + attr("quote") + ">" + esc(h.quote) + "</div>";

    var desc =
      h.description || editing
        ? '<div class="header-description"' +
          attr("description") +
          ">" +
          esc(h.description) +
          "</div>"
        : "";

    return (
      '<div class="page-header">' +
      (row ? '<div class="header-row">' + row + "</div>" : "") +
      desc +
      "</div>"
    );
  }

  function isInternalLink(href) {
    return /^#/.test(href) || /^\/(?!\/)/.test(href);
  }

  // ---------- photo adjustments ----------
  //
  // Rotation and saturation are stored as numbers and applied when the photo
  // is drawn, never written into the image file. Re-encoding a JPEG on every
  // tweak would lose a little quality each time, leave orphaned files behind
  // and make each nudge a slow upload; this way they are instant, free and
  // reversible. The one place that can't work with a drawn-on rotation is the
  // cropper, which has to cut from what is on screen — see the crop action.

  var ROTATIONS = [0, 90, 180, 270];

  function rotationOf(photo) {
    var r = Number(photo.rotate) || 0;
    return ROTATIONS.indexOf(r) === -1 ? 0 : r;
  }

  function saturationOf(photo) {
    var s = Number(photo.saturation);
    return isFinite(s) && s >= 0 && s <= 200 ? s : 100;
  }

  function filterCSS(photo) {
    var s = saturationOf(photo);
    return s === 100 ? "" : "saturate(" + s + "%)";
  }

  // A half turn needs nothing but a transform. A quarter turn changes the box
  // the photo occupies, so the media element declares the turned box's
  // aspect-ratio — which is simply the stored dimensions the other way round —
  // and the image is sized against that before being turned into it. --ar is
  // the image's own width as a fraction of the box width it needs.
  //
  // aspect-ratio rather than the usual percentage-padding trick: a percentage
  // padding resolves against the CONTAINING BLOCK's width, which is the same
  // as the element's own width on the canvas but not in the fixed-width
  // preview inside the Adjust panel.
  function rotationCSS(photo) {
    var r = rotationOf(photo);
    if (!r) return { cls: "", mediaStyle: "", transform: "" };
    if (r === 180) return { cls: "", mediaStyle: "", transform: "rotate(180deg)" };
    var w = photo.width || 1;
    var h = photo.height || 1;
    return {
      cls: " is-rotated",
      mediaStyle:
        "aspect-ratio:" + h + "/" + w +
        ";--ar:" + Math.round((w / h) * 10000) / 10000 +
        ";--rot:" + r + "deg",
      transform: "",
    };
  }

  function styleAttr(css) {
    return css ? ' style="' + esc(css) + '"' : "";
  }

  function imgStyleFor(photo) {
    var rot = rotationCSS(photo);
    var f = filterCSS(photo);
    return (
      (rot.transform ? "transform:" + rot.transform + ";" : "") +
      (f ? "filter:" + f + ";" : "")
    );
  }

  // Photos and text blocks share a canvas and a coordinate system, but live in
  // separate arrays so nothing that walks the photos — publishing, cleaning up
  // deleted image files, the lightbox — has to learn about text. This is the
  // combined view the layout engine works on; the objects are the same ones,
  // so the positions it writes land back in page.photos / page.texts.
  function itemsOf(page) {
    return (page.photos || []).concat(page.texts || []);
  }

  var ALIGNMENTS = ["left", "center", "right"];

  function textHTML(item, order) {
    var editing = window.WB.isEditing();
    var align = ALIGNMENTS.indexOf(item.align) === -1 ? "left" : item.align;
    var tools = editing
      ? '<div class="photo-tools">' +
        '<button data-text-action="align">Align: ' + align + "</button>" +
        '<button data-text-action="remove" class="danger">Remove</button>' +
        "</div>"
      : "";
    // Nearly all of a text block is contenteditable, and the drag engine has to
    // leave that alone so a click can put the caret in it. The grip is the
    // part you drag by.
    var grip = editing ? '<div class="text-grip" title="Drag to move"></div>' : "";
    var handle = editing ? '<div class="resize-handle"></div>' : "";

    return (
      '<div class="photo-block text-block" data-item-id="' +
      esc(item.id) +
      '" style="order:' +
      order +
      '">' +
      tools +
      grip +
      '<div class="text-content" style="text-align:' +
      align +
      '"' +
      (editing ? ' contenteditable="true" data-text-for="' + esc(item.id) + '"' : "") +
      ">" +
      esc(item.text || "") +
      "</div>" +
      handle +
      "</div>"
    );
  }

  function photoHTML(photo, order) {
    var editing = window.WB.isEditing();
    var thumb = window.WB.resolveSrc(photo.thumb);
    var tools = editing
      ? '<div class="photo-tools">' +
        '<button data-photo-action="replace">Replace</button>' +
        '<button data-photo-action="crop">Crop</button>' +
        '<button data-photo-action="adjust">Adjust</button>' +
        '<button data-photo-action="link">Link</button>' +
        '<button data-photo-action="front">Front</button>' +
        '<button data-photo-action="remove" class="danger">Remove</button>' +
        "</div>"
      : "";
    var handle = editing ? '<div class="resize-handle"></div>' : "";
    var caption =
      photo.caption || editing
        ? '<div class="photo-caption"' +
          (editing ? ' contenteditable="true" data-caption-for="' + esc(photo.id) + '"' : "") +
          ">" +
          esc(photo.caption || "") +
          "</div>"
        : "";

    var label = photo.title
      ? '<span class="photo-label"><span>' + esc(photo.title) + "</span></span>"
      : "";

    var rot = rotationCSS(photo);
    var img =
      '<img src="' +
      esc(thumb) +
      '" alt="' +
      esc(photo.title || photo.caption || "") +
      '" width="' +
      (photo.width || "") +
      '" height="' +
      (photo.height || "") +
      '" loading="lazy" decoding="async"' +
      styleAttr(imgStyleFor(photo)) +
      ">";

    // The link is only live outside edit mode — inside it, an anchor would
    // swallow the drag. A marker keeps it visible while editing.
    var media;
    if (photo.link && !editing) {
      var external = !isInternalLink(photo.link);
      media =
        '<a class="photo-media' +
        rot.cls +
        '"' +
        styleAttr(rot.mediaStyle) +
        ' href="' +
        esc(photo.link) +
        '"' +
        (external ? ' target="_blank" rel="noopener noreferrer"' : "") +
        ">" +
        img +
        label +
        "</a>";
    } else {
      media =
        '<span class="photo-media' +
        rot.cls +
        '"' +
        styleAttr(rot.mediaStyle) +
        ">" +
        img +
        label +
        "</span>";
    }

    var linkFlag =
      editing && photo.link
        ? '<span class="link-flag" title="' + esc(photo.link) + '">link</span>'
        : "";

    return (
      '<div class="photo-block" data-item-id="' +
      esc(photo.id) +
      '" data-photo-id="' +
      esc(photo.id) +
      '" style="order:' +
      order +
      '">' +
      tools +
      linkFlag +
      media +
      caption +
      handle +
      "</div>"
    );
  }

  // Rebuilding the page throws away everything in it and puts it back. Where
  // that happens under a reader who is part-way down — a rotation, a photo
  // edited from the panel — the browser can land them somewhere else, so the
  // scroll position is put back afterwards. Navigation still goes to the top:
  // onHashChange does that after this returns.
  function renderPage() {
    var keepScroll = window.scrollY;
    renderPageInner();
    if (keepScroll && window.scrollY !== keepScroll) window.scrollTo(0, keepScroll);
  }

  function renderPageInner() {
    var page = findPage(data, currentId);
    var main = $("main");

    if (!page || page.type === "group") {
      main.innerHTML = '<p class="empty-note">Page not found.</p>';
      return;
    }

    if (page.type === "text") {
      var editing = window.WB.isEditing();
      main.innerHTML =
        headerHTML(page) +
        '<div class="text-body"' +
        (editing ? ' contenteditable="true" data-body-field="1"' : "") +
        ">" +
        esc(page.body || "") +
        "</div>" +
        '<div class="page-footer"></div>';
      return;
    }

    var photos = page.photos || [];
    var texts = page.texts || [];
    var items = itemsOf(page);

    // Blocks stay in array order in the DOM, so paint order — and with it the
    // Front button — behaves exactly as before. `order` reorders them into
    // reading order only in the stacked phone grid, where a free-form position
    // means nothing and text would otherwise all pile up at the bottom.
    var rank = {};
    window.WB.layout.visualOrder(items).forEach(function (item, i) {
      rank[item.id] = i;
    });

    var canvasInner =
      photos
        .map(function (p) {
          return photoHTML(p, rank[p.id]);
        })
        .join("") +
      texts
        .map(function (t) {
          return textHTML(t, rank[t.id]);
        })
        .join("");

    main.innerHTML =
      headerHTML(page) +
      // The frame is what holds the page's height open on a phone, where the
      // canvas itself is laid out wide and then scaled down.
      '<div class="canvas-frame"><div class="canvas" id="canvas">' +
      canvasInner +
      '<div class="snap-overlay"></div>' +
      "</div></div>" +
      (items.length === 0
        ? '<p class="empty-note">' +
          (window.WB.isEditing()
            ? "Nothing here yet — use “Add photos” or “Add text” below."
            : "Nothing here yet.") +
          "</p>"
        : "") +
      '<div class="page-footer"></div>';

    var canvas = $("canvas");
    if (!canvas) return;
    window.WB.layout.applyPositions(canvas, items);
    if (window.WB.isEditing() && window.innerWidth > 820) {
      window.WB.layout.enableEditing(canvas, items, function () {
        markDirty();
      });
    }
  }

  // The heading is either the site name as text or an uploaded wordmark. The
  // name is still carried as alt text and the page title either way.
  function renderHeading() {
    var logo = data.logo || {};
    var src = logo.image ? window.WB.resolveSrc(logo.image) : null;
    document.documentElement.style.setProperty(
      "--logo-width",
      (typeof logo.size === "number" ? logo.size : 100) + "%"
    );
    [$("site-name"), $("mobile-name")].forEach(function (el) {
      if (src) {
        el.innerHTML =
          '<img class="site-logo" src="' +
          esc(src) +
          '" alt="' +
          esc(data.siteName) +
          '">';
      } else {
        el.textContent = data.siteName;
      }
    });
  }

  function render() {
    applyTypography();
    applyCursor();
    applyFooterSpace();
    applyPhoneLayout();
    renderHeading();
    document.title = data.siteName;
    var group = parentGroupOf(data, currentId);
    if (group) openGroups[group.id] = true;
    renderNav();
    renderPage();
    updateEditUI();
    measureMobileBar();
  }

  // ---------- routing ----------

  function routeFromHash() {
    var hash = location.hash.replace(/^#\/?/, "");
    return hash || firstNavigablePage(data);
  }

  function onHashChange() {
    var id = routeFromHash();
    var page = findPage(data, id);
    currentId = page && page.type !== "group" ? id : firstNavigablePage(data);
    closeNav();
    render();
    window.scrollTo(0, 0);
  }

  // ---------- edit UI ----------

  function updateEditUI() {
    var editing = window.WB.isEditing();
    $("edit-bar").hidden = !editing;
    // Visitors never see the button. This is about keeping it out of the way,
    // not about security — the site is public and anyone can read this file.
    // What actually protects the site is the GitHub token, which exists only
    // in this browser; without it nothing can be published, button or no.
    $("edit-site-btn").hidden = editing || !window.WB.editorShown();
    document.body.classList.toggle("is-editing", editing);
  }

  function openModal(html) {
    var root = $("modal-root");
    root.innerHTML = '<div class="modal-overlay"><div class="modal">' + html + "</div></div>";
    var overlay = root.querySelector(".modal-overlay");
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) root.innerHTML = "";
    });
    return root.querySelector(".modal");
  }

  function closeModal() {
    $("modal-root").innerHTML = "";
  }

  // ---------- connect (GitHub token) ----------

  function openConnect() {
    var repo = window.WB.gh.detectRepo();
    var repoValue = repo ? repo.owner + "/" + repo.repo : "";
    var modal = openModal(
      "<h3>Connect GitHub</h3>" +
        '<p class="hint">Paste a fine-grained personal access token with <strong>Contents: Read and write</strong> on the repository below. Edits then save automatically. The token is stored only in this browser.</p>' +
        '<div class="modal-error" id="connect-error" hidden></div>' +
        '<div class="modal-ok" id="connect-ok" hidden></div>' +
        "<label>Repository</label>" +
        '<input type="text" id="repo-input" placeholder="owner/repository" value="' +
        esc(repoValue) +
        '" autocomplete="off" spellcheck="false">' +
        "<label>Token</label>" +
        '<input type="password" id="token-input" placeholder="github_pat_..." autocomplete="off">' +
        '<div class="modal-actions">' +
        (window.WB.gh.hasToken()
          ? '<button class="pill-btn" id="token-remove">Disconnect</button>'
          : "") +
        '<button class="pill-btn" id="token-cancel">Cancel</button>' +
        '<button class="pill-btn pill-solid" id="token-save">Connect</button>' +
        "</div>"
    );

    modal.querySelector("#token-cancel").addEventListener("click", closeModal);
    var removeBtn = modal.querySelector("#token-remove");
    if (removeBtn) {
      removeBtn.addEventListener("click", function () {
        window.WB.gh.setToken(null);
        closeModal();
        setStatus("Disconnected — saving on this device only", "");
      });
    }

    modal.querySelector("#token-save").addEventListener("click", async function () {
      var errEl = modal.querySelector("#connect-error");
      var okEl = modal.querySelector("#connect-ok");
      var btn = modal.querySelector("#token-save");
      var value = modal.querySelector("#token-input").value.trim();
      var repoText = modal.querySelector("#repo-input").value.trim();
      errEl.hidden = true;
      okEl.hidden = true;
      if (!value) {
        errEl.textContent = "Paste a token first.";
        errEl.hidden = false;
        return;
      }
      var parts = repoText.replace(/^https?:\/\/github\.com\//i, "").split("/");
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        errEl.textContent =
          'Enter the repository as owner/repository, e.g. borainwillow-sudo/weddings.';
        errEl.hidden = false;
        return;
      }
      btn.disabled = true;
      btn.textContent = "Checking…";
      window.WB.gh.setRepo(parts[0], parts[1].replace(/\.git$/, ""));
      window.WB.gh.setToken(value);
      try {
        await window.WB.gh.verify();
        okEl.textContent = "Connected. Saving your current work…";
        okEl.hidden = false;
        setTimeout(function () {
          closeModal();
          commit({ manual: true });
        }, 700);
      } catch (err) {
        window.WB.gh.setToken(null);
        errEl.textContent = String(err.message || err);
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = "Connect";
      }
    });
  }

  // ---------- typography panel ----------

  function openTypography() {
    var rows = window.WB.TYPO_ROLES.map(function (role) {
      var cfg = (data.typography && data.typography[role.key]) || {
        weight: 400,
        size: 14,
      };
      var opts = window.WB.WEIGHTS.map(function (w) {
        return (
          '<option value="' +
          w.value +
          '"' +
          (Number(cfg.weight) === w.value ? " selected" : "") +
          ">" +
          w.label +
          "</option>"
        );
      }).join("");
      return (
        '<div class="typo-row" data-role="' +
        role.key +
        '"><span>' +
        role.label +
        "</span>" +
        '<select data-typo="weight">' +
        opts +
        "</select>" +
        '<input type="number" data-typo="size" min="' +
        role.min +
        '" max="' +
        role.max +
        '" value="' +
        cfg.size +
        '"></div>'
      );
    }).join("");

    var logo = data.logo || {};
    var logoSize = typeof logo.size === "number" ? logo.size : 100;
    var logoPreview = logo.image
      ? '<img class="logo-preview" src="' + esc(window.WB.resolveSrc(logo.image)) + '" alt="">'
      : '<span class="hint" style="margin:0">No logo — showing the name as text.</span>';
    var footerSpace =
      data.footer && typeof data.footer.space === "number" ? data.footer.space : 45;
    var phoneLayout = data.phoneLayout === "stacked" ? "stacked" : "desktop";
    var cursor = data.cursor || {};
    var cursorPreview = cursor.image
      ? '<img class="cursor-preview" src="' + esc(window.WB.resolveSrc(cursor.image)) + '" alt="">'
      : '<span class="hint" style="margin:0">No custom cursor — using the normal arrow.</span>';

    var modal = openModal(
      "<h3>Style</h3>" +
        '<p class="hint">Everything is Helvetica — this sets the weight and size for each kind of text. Changes preview instantly.</p>' +
        rows +
        '<div class="group-heading">Heading</div>' +
        '<p class="hint">Replace the name at the top with your own wordmark. Use a PNG with a transparent background so it sits on the white page. The name is still used for the browser tab and for screen readers.</p>' +
        '<div class="cursor-row">' +
        logoPreview +
        '<button class="pill-btn" id="logo-upload">Upload logo</button>' +
        (logo.image ? '<button class="pill-btn" id="logo-clear">Remove</button>' : "") +
        "</div>" +
        (logo.image
          ? '<div class="typo-row"><span>Logo width</span>' +
            '<input type="range" id="logo-size" min="20" max="100" step="5" value="' +
            logoSize +
            '">' +
            '<input type="number" id="logo-size-num" min="20" max="100" step="5" value="' +
            logoSize +
            '"></div>'
          : "") +
        '<div class="group-heading">Cursor</div>' +
        '<p class="hint">Upload a small PNG with a transparent background. Desktop only — touch devices have no pointer — and the normal cursors still apply while you\'re editing.</p>' +
        '<div class="cursor-row">' +
        cursorPreview +
        '<button class="pill-btn" id="cursor-upload">Upload image</button>' +
        (cursor.image ? '<button class="pill-btn" id="cursor-clear">Remove</button>' : "") +
        "</div>" +
        '<div class="typo-row"><span>Size</span>' +
        '<select id="cursor-size">' +
        [16, 24, 32, 48, 64]
          .map(function (s) {
            return (
              '<option value="' + s + '"' +
              ((cursor.size || 32) === s ? " selected" : "") +
              ">" + s + "px</option>"
            );
          })
          .join("") +
        "</select>" +
        '<select id="cursor-hotspot">' +
        '<option value="topleft"' + (cursor.hotspot !== "center" ? " selected" : "") + ">Tip: top-left</option>" +
        '<option value="center"' + (cursor.hotspot === "center" ? " selected" : "") + ">Tip: centre</option>" +
        "</select></div>" +
        '<p class="hint" id="cursor-size-note" hidden>Size applies to the next image you upload.</p>' +
        '<div class="group-heading">End of page</div>' +
        '<p class="hint">Blank space below the last photo on every page. Set as a share of the screen height, so it stays in proportion on any device. Drag to preview it live.</p>' +
        '<div class="typo-row"><span>Space</span>' +
        '<input type="range" id="footer-space" min="0" max="100" step="5" value="' +
        footerSpace +
        '">' +
        '<input type="number" id="footer-space-num" min="0" max="100" step="5" value="' +
        footerSpace +
        '"></div>' +
        '<div class="group-heading">On phones</div>' +
        '<p class="hint">A phone screen is far narrower than the one a layout is composed on, so either the whole arrangement is shrunk to fit, or the photos are stacked into a simple grid instead.</p>' +
        '<div class="typo-row"><span>Layout</span>' +
        '<select id="phone-layout">' +
        '<option value="desktop"' +
        (phoneLayout === "desktop" ? " selected" : "") +
        ">Same as desktop, shrunk</option>" +
        '<option value="stacked"' +
        (phoneLayout === "stacked" ? " selected" : "") +
        ">Stacked grid</option>" +
        "</select></div>" +
        '<p class="hint">Shrunk keeps every photo exactly where you put it, but the type comes down with it and captions get very small — readers can pinch to zoom. Stacked drops the arrangement and shows the photos one after another at a readable size.</p>' +
        '<p class="hint" style="margin-top:18px">Editor version ' +
        EDITOR_VERSION +
        "</p>" +
        '<div class="modal-actions"><button class="pill-btn pill-solid" id="typo-done">Done</button></div>'
    );

    modal.querySelector("#logo-upload").addEventListener("click", function () {
      $("logo-input").click();
    });

    var logoClear = modal.querySelector("#logo-clear");
    if (logoClear) {
      logoClear.addEventListener("click", function () {
        data.logo = { image: null, size: 100 };
        renderHeading();
        markDirty();
        closeModal();
        openTypography();
      });
    }

    var logoRange = modal.querySelector("#logo-size");
    var logoNum = modal.querySelector("#logo-size-num");
    if (logoRange && logoNum) {
      var setLogoSize = function (value) {
        var n = Math.max(20, Math.min(100, Number(value)));
        if (isNaN(n)) return;
        data.logo = data.logo || {};
        data.logo.size = n;
        logoRange.value = n;
        logoNum.value = n;
        renderHeading();
        markDirty();
      };
      logoRange.addEventListener("input", function () {
        setLogoSize(this.value);
      });
      logoNum.addEventListener("input", function () {
        if (this.value !== "") setLogoSize(this.value);
      });
    }

    // Slider and number box drive the same value and mirror each other.
    var spaceRange = modal.querySelector("#footer-space");
    var spaceNum = modal.querySelector("#footer-space-num");

    function setFooterSpace(value) {
      var n = Math.max(0, Math.min(100, Number(value)));
      if (isNaN(n)) return;
      data.footer = data.footer || {};
      data.footer.space = n;
      spaceRange.value = n;
      spaceNum.value = n;
      applyFooterSpace();
      markDirty();
    }

    spaceRange.addEventListener("input", function () {
      setFooterSpace(this.value);
    });
    spaceNum.addEventListener("input", function () {
      if (this.value === "") return;
      setFooterSpace(this.value);
    });

    modal.querySelector("#phone-layout").addEventListener("change", function () {
      data.phoneLayout = this.value === "stacked" ? "stacked" : "desktop";
      applyPhoneLayout();
      renderPage();
      markDirty();
    });

    modal.querySelector("#cursor-upload").addEventListener("click", function () {
      pendingCursorSize = Number(modal.querySelector("#cursor-size").value) || 32;
      $("cursor-input").click();
    });

    modal.querySelector("#cursor-size").addEventListener("change", function () {
      modal.querySelector("#cursor-size-note").hidden = !data.cursor || !data.cursor.image;
    });

    modal.querySelector("#cursor-hotspot").addEventListener("change", function () {
      data.cursor = data.cursor || {};
      data.cursor.hotspot = this.value;
      applyCursor();
      markDirty();
    });

    var clearBtn = modal.querySelector("#cursor-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        data.cursor = { image: null, size: 32, hotspot: "topleft" };
        applyCursor();
        markDirty();
        closeModal();
        openTypography();
      });
    }

    modal.addEventListener("input", function (e) {
      // The cursor-size and end-of-page rows reuse this row layout but are not
      // text roles. Without this guard they wrote to typography[undefined].
      var row = e.target.closest(".typo-row[data-role]");
      if (!row) return;
      var key = row.dataset.role;
      data.typography = data.typography || {};
      data.typography[key] = data.typography[key] || { weight: 400, size: 14 };
      if (e.target.dataset.typo === "weight") {
        data.typography[key].weight = Number(e.target.value);
      } else {
        var n = Number(e.target.value);
        if (!n) return;
        data.typography[key].size = n;
      }
      applyTypography();
      markDirty();
    });

    modal.querySelector("#typo-done").addEventListener("click", closeModal);
  }

  // ---------- pages panel ----------

  function openPages() {
    // Buttons rather than drag-and-drop: reordering has to work on a
    // touchscreen, where dragging a list row fights with scrolling the panel.
    function rowHTML(page, isChild, index, total) {
      return (
        '<div class="page-row' +
        (isChild ? " child" : "") +
        '" data-page="' +
        esc(page.id) +
        '">' +
        '<input type="text" value="' +
        esc(page.title) +
        '" data-page-title>' +
        '<button class="move-btn" data-move="up" title="Move up"' +
        (index === 0 ? " disabled" : "") +
        ">&uarr;</button>" +
        '<button class="move-btn" data-move="down" title="Move down"' +
        (index === total - 1 ? " disabled" : "") +
        ">&darr;</button>" +
        '<button class="del-btn" data-page-delete title="Delete">&times;</button>' +
        "</div>"
      );
    }

    var html = "<h3>Pages</h3>" +
      '<p class="hint">Rename pages, reorder them with the arrows, remove them, or add new ones. The order here is the order they appear in the menu. Deleting a page also deletes its photos from the site.</p>';

    var topCount = (data.pages || []).length;
    (data.pages || []).forEach(function (page, topIndex) {
      if (page.type === "group") {
        html += '<div class="group-heading">' + esc(page.title) + "</div>";
        html += rowHTML(page, false, topIndex, topCount);
        (page.children || []).forEach(function (c, ci) {
          html += rowHTML(c, true, ci, (page.children || []).length);
        });
        html +=
          '<div class="page-row child"><button class="pill-btn" data-add-child="' +
          esc(page.id) +
          '">+ Add page here</button></div>';
      } else {
        html += rowHTML(page, false, topIndex, topCount);
      }
    });

    html +=
      '<div class="modal-actions">' +
      '<button class="pill-btn" id="add-top">+ Add top-level page</button>' +
      '<button class="pill-btn" id="add-group">+ Add section</button>' +
      '<button class="pill-btn pill-solid" id="pages-done">Done</button>' +
      "</div>";

    var modal = openModal(html);

    modal.addEventListener("input", function (e) {
      if (!e.target.matches("[data-page-title]")) return;
      var id = e.target.closest(".page-row").dataset.page;
      var page = findPage(data, id);
      if (!page) return;
      page.title = e.target.value;
      renderNav();
      markDirty();
    });

    modal.addEventListener("click", function (e) {
      var moveBtn = e.target.closest("[data-move]");
      if (moveBtn) {
        var mid = moveBtn.closest(".page-row").dataset.page;
        // A page moves within its own list — top-level pages among top-level
        // pages, children within their section.
        var group = parentGroupOf(data, mid);
        var list = group ? group.children : data.pages;
        var from = list.findIndex(function (p) {
          return p.id === mid;
        });
        var to = from + (moveBtn.dataset.move === "up" ? -1 : 1);
        if (from === -1 || to < 0 || to >= list.length) return;
        var moved = list.splice(from, 1)[0];
        list.splice(to, 0, moved);
        markDirty();
        closeModal();
        openPages();
        render();
        return;
      }

      var delBtn = e.target.closest("[data-page-delete]");
      if (delBtn) {
        var id = delBtn.closest(".page-row").dataset.page;
        var page = findPage(data, id);
        if (!page) return;
        if (!confirm('Delete "' + page.title + '"? Its photos will be removed from the site.')) return;
        var group = parentGroupOf(data, id);
        if (group) {
          group.children = group.children.filter(function (c) {
            return c.id !== id;
          });
        } else {
          data.pages = data.pages.filter(function (p) {
            return p.id !== id;
          });
        }
        if (currentId === id) {
          location.hash = "#/" + firstNavigablePage(data);
        }
        markDirty();
        closeModal();
        openPages();
        render();
        return;
      }

      var addChild = e.target.closest("[data-add-child]");
      if (addChild) {
        var groupId = addChild.dataset.addChild;
        var g = findPage(data, groupId);
        var title = prompt("Page name:");
        if (!title) return;
        var np = window.WB.galleryPage(title);
        np.id = uniquePageId(data, title);
        g.children = g.children || [];
        g.children.push(np);
        markDirty();
        closeModal();
        openPages();
        render();
        return;
      }

      if (e.target.id === "add-top") {
        var t = prompt("Page name:");
        if (!t) return;
        var p = window.WB.galleryPage(t);
        p.id = uniquePageId(data, t);
        data.pages.push(p);
        markDirty();
        closeModal();
        openPages();
        render();
        return;
      }

      if (e.target.id === "add-group") {
        var gt = prompt("Section name:");
        if (!gt) return;
        data.pages.push({
          id: uniquePageId(data, gt),
          title: gt,
          type: "group",
          children: [],
        });
        markDirty();
        closeModal();
        openPages();
        render();
        return;
      }

      if (e.target.id === "pages-done") closeModal();
    });
  }

  // ---------- photo actions ----------

  var replaceTargetId = null;
  var pendingCursorSize = 32;

  async function addFiles(fileList) {
    var page = findPage(data, currentId);
    if (!page || page.type !== "gallery") {
      alert("Photos can only be added to a gallery page.");
      return;
    }
    page.photos = page.photos || [];
    var files = Array.from(fileList);
    var done = 0;
    var failed = [];
    var memoryOnly = 0;

    // New photos are laid out in columns below whatever is already there.
    // One cursor per column, each new photo going to whichever column is
    // currently shortest, so varying photo heights don't leave one column
    // trailing far behind the others.
    var colGeo = window.WB.layout.columnGeometry();
    var cursors = window.WB.layout.newColumnCursors(page.photos);

    setStatus("Processing 0/" + files.length + "…", "is-saving");

    for (var i = 0; i < files.length; i++) {
      try {
        var processed = await window.WB.processFile(files[i]);
        var durable = await window.WB.addPendingPhoto(processed);
        if (!durable) memoryOnly++;
        var col = window.WB.layout.shortestColumn(cursors);
        var photo = {
          id: processed.id,
          display: processed.displayPath,
          thumb: processed.thumbPath,
          width: processed.width,
          height: processed.height,
          caption: "",
          x: Math.round(colGeo.xs[col] * 100) / 100,
          y: Math.round(cursors[col] * 100) / 100,
          w: colGeo.width,
        };
        page.photos.push(photo);
        cursors[col] +=
          window.WB.layout.heightPct(photo) + window.WB.layout.GAP;
        sessionAddedIds[processed.id] = true;
        done++;
        setStatus("Processing " + done + "/" + files.length + "…", "is-saving");
        // Record progress as we go: a batch interrupted halfway keeps the
        // photos already done instead of losing the lot.
        window.WB.saveDraft(data);
        // Yield between photos so a long batch doesn't monopolise the main
        // thread, which is what pushes iOS into the memory failures above.
        await new Promise(function (r) {
          setTimeout(r, 0);
        });
      } catch (err) {
        // Previously swallowed, so a photo that failed to encode just quietly
        // never appeared. The file is named so it can be retried.
        console.error(err);
        failed.push(files[i].name || "one photo");
      }
    }

    render();
    markDirty();
    // The new photos are at the end of the page, so show them.
    if (done) {
      window.scrollTo({
        top: document.body.scrollHeight,
        behavior: "smooth",
      });
    }

    if (failed.length) {
      showNotice(
        failed.length +
          " of " +
          files.length +
          " photos couldn't be processed (" +
          failed.slice(0, 3).join(", ") +
          (failed.length > 3 ? "…" : "") +
          "). This is usually memory pressure on a large batch — try adding them again, a few at a time."
      );
    } else if (memoryOnly) {
      showNotice(
        memoryOnly +
          " photo(s) could only be held in memory, not stored. Press Save now before closing this tab, or they will be lost."
      );
    }
  }

  async function applyProcessedTo(photo, processed) {
    await window.WB.addPendingPhoto(processed);
    photo.display = processed.displayPath;
    photo.thumb = processed.thumbPath;
    photo.width = processed.width;
    photo.height = processed.height;
    render();
    markDirty();
  }

  // Both are stored only when they differ from the default, so a page of
  // untouched photos stays exactly as it was in data.json.
  function setRotation(photo, deg) {
    if (deg) photo.rotate = deg;
    else delete photo.rotate;
  }

  function setSaturation(photo, pct) {
    if (pct === 100) delete photo.saturation;
    else photo.saturation = pct;
  }

  function openAdjust(photo) {
    function previewHTML() {
      var rot = rotationCSS(photo);
      return (
        '<span class="photo-media' +
        rot.cls +
        '"' +
        styleAttr(rot.mediaStyle) +
        '><img src="' +
        esc(window.WB.resolveSrc(photo.thumb)) +
        '" alt=""' +
        styleAttr(imgStyleFor(photo)) +
        "></span>"
      );
    }

    var modal = openModal(
      "<h3>Adjust photo</h3>" +
        '<div class="adjust-preview">' +
        previewHTML() +
        "</div>" +
        '<label>Rotation <span class="typo-value" id="rot-readout"></span></label>' +
        '<div class="adjust-rotate">' +
        '<button class="pill-btn" data-turn="-90">&#8634; Left</button>' +
        '<button class="pill-btn" data-turn="90">&#8635; Right</button>' +
        "</div>" +
        '<label>Saturation <span class="typo-value" id="sat-readout"></span></label>' +
        '<input type="range" min="0" max="200" step="1" id="sat-range">' +
        '<p class="hint">0% is black and white, 100% is the photo as shot. Both settings are applied when the photo is drawn rather than written into the file, so they cost nothing, never lose quality, and can be undone at any time.</p>' +
        '<div class="modal-actions">' +
        '<button class="pill-btn" id="adjust-reset">Reset</button>' +
        '<button class="pill-btn pill-solid" id="adjust-done">Done</button>' +
        "</div>"
    );

    var range = modal.querySelector("#sat-range");

    function refresh() {
      modal.querySelector(".adjust-preview").innerHTML = previewHTML();
      modal.querySelector("#rot-readout").textContent = rotationOf(photo) + "°";
      modal.querySelector("#sat-readout").textContent = saturationOf(photo) + "%";
      range.value = String(saturationOf(photo));
    }
    refresh();

    // Saturation slides continuously, and re-rendering a page of two hundred
    // photos per frame would crawl. The filter is written straight onto the
    // elements already on screen instead, and only the release is saved.
    function liveFilter() {
      var f = filterCSS(photo);
      document
        .querySelectorAll('[data-photo-id="' + photo.id + '"] img, .adjust-preview img')
        .forEach(function (el) {
          el.style.filter = f;
        });
    }

    range.addEventListener("input", function () {
      setSaturation(photo, Number(range.value));
      modal.querySelector("#sat-readout").textContent = saturationOf(photo) + "%";
      liveFilter();
    });
    range.addEventListener("change", markDirty);

    modal.addEventListener("click", function (e) {
      var turn = e.target.closest("[data-turn]");
      if (turn) {
        setRotation(photo, (rotationOf(photo) + Number(turn.dataset.turn) + 360) % 360);
        render();
        refresh();
        markDirty();
        return;
      }
      if (e.target.id === "adjust-reset") {
        setRotation(photo, 0);
        setSaturation(photo, 100);
        render();
        refresh();
        markDirty();
        return;
      }
      if (e.target.id === "adjust-done") closeModal();
    });
  }

  function handleTextAction(action, textId) {
    var page = findPage(data, currentId);
    if (!page || !page.texts) return;
    var idx = page.texts.findIndex(function (t) {
      return t.id === textId;
    });
    if (idx === -1) return;
    var item = page.texts[idx];

    if (action === "remove") {
      if (!confirm("Remove this text from the page?")) return;
      page.texts.splice(idx, 1);
      render();
      markDirty();
      return;
    }

    if (action === "align") {
      var at = ALIGNMENTS.indexOf(item.align);
      item.align = ALIGNMENTS[(at + 1) % ALIGNMENTS.length];
      render();
      markDirty();
    }
  }

  function addTextBlock() {
    var page = findPage(data, currentId);
    if (!page || page.type !== "gallery") {
      showNotice("Text blocks can only go on a photo page.");
      return;
    }
    page.texts = page.texts || [];
    var place = window.WB.layout.defaultTextPlacement(itemsOf(page));
    var item = {
      id: window.WB.uid(),
      type: "text",
      text: "",
      align: "left",
      x: place.x,
      y: place.y,
      w: place.w,
    };
    page.texts.push(item);
    render();
    markDirty();

    // Drop the caret straight in, and bring it into view — a new block sits
    // below everything else, which on a long page is off screen. Not a smooth
    // scroll: focus() jumps to the element anyway, and the two fight.
    var el = document.querySelector('[data-text-for="' + item.id + '"]');
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "center" });
    }
  }

  function handlePhotoAction(action, photoId) {
    var page = findPage(data, currentId);
    if (!page || !page.photos) return;
    var idx = page.photos.findIndex(function (p) {
      return p.id === photoId;
    });
    if (idx === -1) return;
    var photo = page.photos[idx];

    if (action === "remove") {
      if (!confirm("Remove this photo from the page?")) return;
      page.photos.splice(idx, 1);
      render();
      markDirty();
      return;
    }

    if (action === "front") {
      page.photos.splice(idx, 1);
      page.photos.push(photo);
      render();
      markDirty();
      return;
    }

    if (action === "replace") {
      replaceTargetId = photoId;
      $("replace-input").click();
      return;
    }

    if (action === "link") {
      openPhotoLink(photo);
      return;
    }

    if (action === "adjust") {
      openAdjust(photo);
      return;
    }

    if (action === "crop") {
      cropPhoto(photo);
    }
  }

  async function cropPhoto(photo) {
    var src = window.WB.resolveSrc(photo.display);
    var turned = rotationOf(photo);
    // A crop has to be taken from what is on screen. Rotation is normally only
    // drawn on, so it is rendered into the source first — and since the cropped
    // file then comes out upright, the stored rotation is cleared with it.
    if (turned) {
      setStatus("Preparing crop…", "is-saving");
      try {
        src = await window.WB.rotateToObjectUrl(src, turned);
      } catch (err) {
        showNotice("Could not prepare that photo for cropping: " + err.message);
        setStatus("Editing", "");
        return;
      }
      setStatus("Editing", "");
    }
    var startAspect = photo.height && photo.width ? photo.height / photo.width : 1;
    window.WB.openCropper(src, startAspect, async function (dataUrl) {
      setStatus("Processing crop…", "is-saving");
      var processed = await window.WB.processDataUrl(dataUrl);
      setRotation(photo, 0);
      applyProcessedTo(photo, processed);
    });
  }

  // Per-photo hover label and click-through link.
  function openPhotoLink(photo) {
    var pageOptions = allPages(data)
      .filter(function (p) {
        return p.type !== "group";
      })
      .map(function (p) {
        return (
          '<option value="#/' +
          esc(p.id) +
          '"' +
          (photo.link === "#/" + p.id ? " selected" : "") +
          ">" +
          esc(p.title) +
          "</option>"
        );
      })
      .join("");

    var modal = openModal(
      "<h3>Link &amp; label</h3>" +
        '<p class="hint">The label fades in over the photo on hover (desktop only). The link opens when the photo is clicked — a photo with a link no longer opens the lightbox.</p>' +
        "<label>Hover label</label>" +
        '<input type="text" id="photo-title" placeholder="e.g. Girlhood" value="' +
        esc(photo.title || "") +
        '">' +
        "<label>Link to a page on this site</label>" +
        '<select id="photo-page"><option value="">— none —</option>' +
        pageOptions +
        "</select>" +
        "<label>…or any web address</label>" +
        '<input type="text" id="photo-link" placeholder="https://…" value="' +
        esc(photo.link || "") +
        '" spellcheck="false">' +
        '<div class="modal-actions">' +
        '<button class="pill-btn" id="photo-link-clear">Clear link</button>' +
        '<button class="pill-btn" id="photo-link-cancel">Cancel</button>' +
        '<button class="pill-btn pill-solid" id="photo-link-save">Save</button>' +
        "</div>"
    );

    modal.querySelector("#photo-page").addEventListener("change", function () {
      if (this.value) modal.querySelector("#photo-link").value = this.value;
    });

    modal.querySelector("#photo-link-cancel").addEventListener("click", closeModal);

    modal.querySelector("#photo-link-clear").addEventListener("click", function () {
      photo.link = "";
      closeModal();
      render();
      markDirty();
    });

    modal.querySelector("#photo-link-save").addEventListener("click", function () {
      photo.title = modal.querySelector("#photo-title").value.trim();
      var href = modal.querySelector("#photo-link").value.trim();
      // A bare domain typed without a scheme would otherwise resolve as a
      // relative path on this site.
      if (href && !/^(https?:\/\/|mailto:|#|\/)/i.test(href)) {
        href = "https://" + href;
      }
      photo.link = href;
      closeModal();
      render();
      markDirty();
    });
  }

  function openLightbox(photo) {
    var root = $("modal-root");
    var r = rotationOf(photo);
    var f = filterCSS(photo);
    // The transform doesn't change the layout box, so a quarter-turned photo
    // is constrained by the opposite axis to keep the rotated result on screen.
    var quarter = r === 90 || r === 270;
    var css =
      (r ? "transform:rotate(" + r + "deg);" : "") + (f ? "filter:" + f + ";" : "");
    root.innerHTML =
      '<div class="lightbox"><button class="lightbox-close" aria-label="Close">&times;</button>' +
      '<img class="lightbox-img' +
      (quarter ? " quarter" : "") +
      '"' +
      styleAttr(css) +
      ' src="' +
      esc(window.WB.resolveSrc(photo.display)) +
      '" alt="' +
      esc(photo.caption || "") +
      '"></div>';
    root.querySelector(".lightbox").addEventListener("click", function (e) {
      if (e.target.tagName !== "IMG") root.innerHTML = "";
    });
  }

  // ---------- events ----------

  $("main").addEventListener("click", function (e) {
    var toolBtn = e.target.closest("[data-photo-action]");
    if (toolBtn) {
      e.stopPropagation();
      var block = toolBtn.closest("[data-photo-id]");
      handlePhotoAction(toolBtn.dataset.photoAction, block.dataset.photoId);
      return;
    }
    var textBtn = e.target.closest("[data-text-action]");
    if (textBtn) {
      e.stopPropagation();
      handleTextAction(
        textBtn.dataset.textAction,
        textBtn.closest("[data-item-id]").dataset.itemId
      );
      return;
    }
    if (window.WB.isEditing()) return;
    // A linked photo follows its link; the lightbox would otherwise open on
    // top of the page just navigated to.
    if (e.target.closest("a.photo-media")) return;
    var pb = e.target.closest("[data-photo-id]");
    if (!pb) return;
    var page = findPage(data, currentId);
    var photo = (page.photos || []).find(function (p) {
      return p.id === pb.dataset.photoId;
    });
    if (photo) openLightbox(photo);
  });

  $("main").addEventListener("focusout", function (e) {
    var el = e.target;
    if (!el.hasAttribute || !el.hasAttribute("contenteditable")) return;
    var page = findPage(data, currentId);
    if (!page) return;
    var text = el.textContent.trim();

    if (el.dataset.headerField) {
      page.header = page.header || window.WB.emptyHeader();
      page.header[el.dataset.headerField] = text;
    } else if (el.dataset.bodyField) {
      page.body = el.textContent;
    } else if (el.dataset.captionFor) {
      var photo = (page.photos || []).find(function (p) {
        return p.id === el.dataset.captionFor;
      });
      if (photo) photo.caption = text;
    } else if (el.dataset.textFor) {
      var block = (page.texts || []).find(function (t) {
        return t.id === el.dataset.textFor;
      });
      // innerText, not textContent: it reports the line breaks the browser
      // inserted as <div>/<br> while typing, so paragraphs survive a reload.
      if (block) block.text = el.innerText.replace(/\s+$/, "");
    }
    markDirty();
  });

  $("nav-content").addEventListener("click", function (e) {
    var toggle = e.target.closest("[data-group]");
    if (toggle) {
      var id = toggle.dataset.group;
      openGroups[id] = !openGroups[id];
      renderNav();
      return;
    }
    if (e.target.closest("a.nav-item")) closeNav();
  });

  function closeNav() {
    $("sidebar").classList.remove("open");
    $("nav-backdrop").classList.remove("open");
    $("nav-toggle").setAttribute("aria-expanded", "false");
  }

  $("nav-toggle").addEventListener("click", function () {
    var open = $("sidebar").classList.toggle("open");
    $("nav-backdrop").classList.toggle("open", open);
    this.setAttribute("aria-expanded", String(open));
  });
  $("nav-backdrop").addEventListener("click", closeNav);

  $("edit-site-btn").addEventListener("click", async function () {
    var auth = window.WB.getAuth();
    if (!auth) {
      var pw = prompt("Set a password for editing this site:");
      if (!pw) return;
      if (pw !== prompt("Confirm password:")) {
        alert("Passwords did not match.");
        return;
      }
      await window.WB.setPassword(pw);
    } else {
      var entered = prompt("Enter password to edit:");
      if (entered === null) return;
      if (!(await window.WB.verifyPassword(entered))) {
        alert("Incorrect password.");
        return;
      }
    }
    window.WB.setEditing(true);
    render();
    setStatus(
      window.WB.gh.hasToken()
        ? "Editing — changes save automatically"
        : "Editing — connect GitHub to publish",
      ""
    );
  });

  $("btn-exit-edit").addEventListener("click", async function () {
    if (isDirty() && window.WB.gh.hasToken()) await commit({ manual: true });
    window.WB.setEditing(false);
    closeModal();
    render();
  });

  $("edit-notice-close").addEventListener("click", function () {
    $("edit-notice").hidden = true;
  });

  $("btn-save-now").addEventListener("click", function () {
    commit({ manual: true });
  });
  $("btn-connect").addEventListener("click", openConnect);
  $("btn-typography").addEventListener("click", openTypography);
  $("btn-pages").addEventListener("click", openPages);
  $("btn-add-photo").addEventListener("click", function () {
    $("file-input").click();
  });
  $("btn-add-text").addEventListener("click", addTextBlock);

  // One-click tidy: reflow the whole page into columns. Destroys a hand-made
  // arrangement, so it asks first.
  $("btn-arrange").addEventListener("click", function () {
    var page = findPage(data, currentId);
    var items = page ? itemsOf(page) : [];
    if (!page || page.type !== "gallery" || !items.length) {
      showNotice("Nothing to arrange on this page.");
      return;
    }
    if (
      !confirm(
        "Rearrange everything on this page (" +
          items.length +
          " items) into three columns? This replaces their current positions."
      )
    ) {
      return;
    }
    // Flowed in reading order, not array order: text blocks live in their own
    // array, so array order would sweep every one of them to the bottom. The
    // order is fixed up front so the second pass keeps it.
    var ordered = window.WB.layout.visualOrder(items);

    // Twice, because narrowing a text block to a column makes it taller and
    // the first pass can only pack it using its height at the old width. The
    // render in between measures the new heights; the second pass uses them.
    window.WB.layout.arrangeInColumns(ordered);
    render();
    window.WB.layout.arrangeInColumns(ordered);
    render();
    markDirty();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("file-input").addEventListener("change", function (e) {
    // FileList is live — copy it before resetting the input, or it empties.
    var files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length) addFiles(files);
  });

  $("logo-input").addEventListener("change", async function (e) {
    var file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setStatus("Processing logo…", "is-saving");
    try {
      var processed = await window.WB.processLogoFile(file);
      await window.WB.addPendingFiles(processed.id, [
        { path: processed.path, blob: processed.blob },
      ]);
      data.logo = {
        image: processed.path,
        width: processed.width,
        height: processed.height,
        size: (data.logo && typeof data.logo.size === "number") ? data.logo.size : 100,
      };
      renderHeading();
      markDirty();
      closeModal();
      openTypography();
      // Animated files bypass resizing to keep their frames, so an oversized
      // one would quietly slow every page load.
      if (processed.animated) {
        var kb = processed.blob.size;
        setStatus(
          kb > 3 * 1024 * 1024
            ? "Animated logo added (" +
                window.WB.formatBytes(kb) +
                ") — large files slow the site; consider a smaller export"
            : "Animated logo added (" + window.WB.formatBytes(kb) + ")",
          kb > 3 * 1024 * 1024 ? "is-error" : ""
        );
      }
    } catch (err) {
      setStatus("Could not read that image", "is-error");
    }
  });

  $("cursor-input").addEventListener("change", async function (e) {
    var file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setStatus("Processing cursor…", "is-saving");
    try {
      var processed = await window.WB.processCursorFile(file, pendingCursorSize);
      await window.WB.addPendingFiles(processed.id, [
        { path: processed.path, blob: processed.blob },
      ]);
      data.cursor = {
        image: processed.path,
        size: pendingCursorSize,
        width: processed.width,
        height: processed.height,
        hotspot: (data.cursor && data.cursor.hotspot) || "topleft",
      };
      applyCursor();
      markDirty();
      closeModal();
      openTypography();
    } catch (err) {
      setStatus("Could not read that image", "is-error");
    }
  });

  $("replace-input").addEventListener("change", async function (e) {
    var file = e.target.files[0];
    e.target.value = "";
    if (!file || !replaceTargetId) return;
    var page = findPage(data, currentId);
    var photo = (page.photos || []).find(function (p) {
      return p.id === replaceTargetId;
    });
    replaceTargetId = null;
    if (!photo) return;
    setStatus("Processing…", "is-saving");
    var processed = await window.WB.processFile(file);
    // A different photo in the same slot: a rotation and a saturation chosen
    // for the old one mean nothing for the new one.
    setRotation(photo, 0);
    setSaturation(photo, 100);
    applyProcessedTo(photo, processed);
  });

  window.addEventListener("hashchange", onHashChange);

  window.addEventListener("beforeunload", function (e) {
    if (isDirty() && window.WB.gh.hasToken() && window.WB.isEditing()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  var resizeTimer = null;
  var lastWidth = window.innerWidth;
  window.addEventListener("resize", function () {
    // Not debounced: turning the phone changes whether the name wraps, and the
    // drawer must never be left sitting behind the bar, even briefly.
    measureMobileBar();

    // A phone hides its address bar as you scroll down and shows it again as
    // you scroll back, and each of those fires a resize with the width
    // unchanged. Rebuilding the page there replaces everything the reader is
    // scrolling through mid-gesture, which is what made a fast scroll stutter
    // and jump. Only a real width change can alter the layout, so only a real
    // width change earns a re-render.
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderPage, 180);
  });

  // ---------- boot ----------

  (async function init() {
    // A device that doesn't show the editor has no business being left in edit
    // mode — otherwise ?edit=off would hide the button but leave the toolbar.
    if (!window.WB.editorShown()) window.WB.setEditing(false);
    data = await window.WB.getData();
    var cleaned = pruneTypography();
    // Restore photos staged but not yet published in an earlier session, so
    // they render instead of 404-ing.
    var restored = await window.WB.initPending();
    if (cleaned && window.WB.isEditing()) markDirty();
    currentId = routeFromHash();
    var page = findPage(data, currentId);
    if (!page || page.type === "group") currentId = firstNavigablePage(data);
    render();
    if (window.WB.isEditing()) {
      if (restored) {
        dirtyVersion++;
        setStatus(
          restored + " photo(s) waiting to publish — press Save now",
          ""
        );
      } else {
        setStatus(
          window.WB.gh.hasToken()
            ? "Editing — changes save automatically"
            : "Editing — connect GitHub to publish",
          ""
        );
      }
    }
  })();
})();
