(function () {
  // The whole photo stays visible and a crop box is dragged over it, rather
  // than panning the photo behind a fixed window. The area outside the box is
  // dimmed, so what you're keeping and what you're discarding are both legible.
  var PRESETS = [
    { label: "Free", value: 0 },
    { label: "Original", value: -1 },
    { label: "1:1", value: 1 },
    { label: "4:5", value: 4 / 5 },
    { label: "5:4", value: 5 / 4 },
    { label: "2:3", value: 2 / 3 },
    { label: "3:2", value: 3 / 2 },
    { label: "16:9", value: 16 / 9 },
  ];

  var HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  var MIN_PX = 24;

  function openCropper(imageSrc, startAspect, onApply) {
    var root = document.getElementById("modal-root");
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    var box = document.createElement("div");
    box.className = "modal crop-modal";
    box.innerHTML =
      "<h3>Crop photo</h3>" +
      '<p class="hint">Drag inside the box to move it, or pull a corner or edge to resize. Everything outside the box is removed. The crop is taken at full resolution.</p>' +
      '<div class="crop-presets">' +
      PRESETS.map(function (p, i) {
        return (
          '<button class="pill-btn crop-preset" data-ratio="' +
          p.value +
          '"' +
          (i === 0 ? ' aria-pressed="true"' : "") +
          ">" +
          p.label +
          "</button>"
        );
      }).join("") +
      "</div>" +
      '<div class="crop-stage"><img class="crop-img" alt=""><div class="crop-rect">' +
      HANDLES.map(function (h) {
        return '<span class="crop-handle crop-' + h + '" data-dir="' + h + '"></span>';
      }).join("") +
      '<span class="crop-thirds"></span></div></div>' +
      '<p class="hint crop-readout"></p>' +
      '<div class="modal-actions">' +
      '<button class="pill-btn" id="crop-reset">Reset</button>' +
      '<button class="pill-btn" id="crop-cancel">Cancel</button>' +
      '<button class="pill-btn pill-solid" id="crop-apply">Apply crop</button>' +
      "</div>";

    overlay.appendChild(box);
    root.innerHTML = "";
    root.appendChild(overlay);

    var stage = box.querySelector(".crop-stage");
    var img = box.querySelector(".crop-img");
    var rectEl = box.querySelector(".crop-rect");
    var readout = box.querySelector(".crop-readout");

    var natW = 0,
      natH = 0,
      dispW = 0,
      dispH = 0,
      scale = 1;
    var rect = { x: 0, y: 0, w: 0, h: 0 };
    var ratio = 0; // 0 = free

    function fitStage() {
      var maxW = Math.min(560, window.innerWidth - 90);
      var maxH = Math.max(220, window.innerHeight * 0.52);
      scale = Math.min(maxW / natW, maxH / natH, 1);
      dispW = Math.round(natW * scale);
      dispH = Math.round(natH * scale);
      stage.style.width = dispW + "px";
      stage.style.height = dispH + "px";
      img.style.width = dispW + "px";
      img.style.height = dispH + "px";
    }

    function clampRect() {
      rect.w = Math.max(MIN_PX, Math.min(rect.w, dispW));
      rect.h = Math.max(MIN_PX, Math.min(rect.h, dispH));
      rect.x = Math.max(0, Math.min(rect.x, dispW - rect.w));
      rect.y = Math.max(0, Math.min(rect.y, dispH - rect.h));
    }

    function draw() {
      clampRect();
      rectEl.style.left = rect.x + "px";
      rectEl.style.top = rect.y + "px";
      rectEl.style.width = rect.w + "px";
      rectEl.style.height = rect.h + "px";
      readout.textContent =
        Math.round(rect.w / scale) + " × " + Math.round(rect.h / scale) + " px";
    }

    // Largest box of the given ratio that fits, centred.
    function resetRect(r) {
      if (!r) {
        rect = { x: 0, y: 0, w: dispW, h: dispH };
      } else {
        var w = dispW;
        var h = w / r;
        if (h > dispH) {
          h = dispH;
          w = h * r;
        }
        rect = { x: (dispW - w) / 2, y: (dispH - h) / 2, w: w, h: h };
      }
      draw();
    }

    function applyRatio(r) {
      ratio = r;
      if (r) {
        // Keep the centre, fit the ratio inside the current box.
        var cx = rect.x + rect.w / 2;
        var cy = rect.y + rect.h / 2;
        var w = rect.w;
        var h = w / r;
        if (h > dispH) {
          h = dispH;
          w = h * r;
        }
        if (w > dispW) {
          w = dispW;
          h = w / r;
        }
        rect = { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
      }
      draw();
    }

    img.onload = function () {
      natW = img.naturalWidth;
      natH = img.naturalHeight;
      // A rotated photo is handed in as a freshly rendered object URL. Once
      // the image has decoded it no longer needs the URL, and holding it would
      // leak the blob for the life of the page.
      if (imageSrc.slice(0, 5) === "blob:") URL.revokeObjectURL(imageSrc);
      fitStage();
      resetRect(0);
    };
    img.src = imageSrc;

    // ---- interaction ----
    var drag = null;

    stage.addEventListener("pointerdown", function (e) {
      var handle = e.target.closest(".crop-handle");
      var inside = e.target.closest(".crop-rect");
      if (!handle && !inside) return;
      e.preventDefault();
      drag = {
        dir: handle ? handle.dataset.dir : null,
        startX: e.clientX,
        startY: e.clientY,
        orig: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      };
      stage.setPointerCapture(e.pointerId);
    });

    stage.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      var o = drag.orig;

      if (!drag.dir) {
        rect.x = o.x + dx;
        rect.y = o.y + dy;
        draw();
        return;
      }

      var left = o.x;
      var top = o.y;
      var right = o.x + o.w;
      var bottom = o.y + o.h;

      if (drag.dir.indexOf("w") !== -1) left = Math.min(o.x + dx, right - MIN_PX);
      if (drag.dir.indexOf("e") !== -1) right = Math.max(o.x + o.w + dx, left + MIN_PX);
      if (drag.dir.indexOf("n") !== -1) top = Math.min(o.y + dy, bottom - MIN_PX);
      if (drag.dir.indexOf("s") !== -1) bottom = Math.max(o.y + o.h + dy, top + MIN_PX);

      left = Math.max(0, left);
      top = Math.max(0, top);
      right = Math.min(dispW, right);
      bottom = Math.min(dispH, bottom);

      var w = right - left;
      var h = bottom - top;

      if (ratio) {
        // Derive the other side from whichever the handle actually drives.
        if (drag.dir === "n" || drag.dir === "s") {
          w = h * ratio;
        } else if (drag.dir === "e" || drag.dir === "w") {
          h = w / ratio;
        } else {
          h = w / ratio;
        }
        if (w > dispW) {
          w = dispW;
          h = w / ratio;
        }
        if (h > dispH) {
          h = dispH;
          w = h * ratio;
        }
        if (drag.dir.indexOf("w") !== -1) left = right - w;
        if (drag.dir.indexOf("n") !== -1) top = bottom - h;
      }

      rect = { x: left, y: top, w: w, h: h };
      draw();
    });

    ["pointerup", "pointercancel"].forEach(function (ev) {
      stage.addEventListener(ev, function () {
        drag = null;
      });
    });

    box.querySelector(".crop-presets").addEventListener("click", function (e) {
      var btn = e.target.closest(".crop-preset");
      if (!btn) return;
      box.querySelectorAll(".crop-preset").forEach(function (b) {
        b.removeAttribute("aria-pressed");
      });
      btn.setAttribute("aria-pressed", "true");
      var r = Number(btn.dataset.ratio);
      if (r === -1) r = natW / natH;
      applyRatio(r);
    });

    box.querySelector("#crop-reset").addEventListener("click", function () {
      resetRect(ratio);
    });

    function close() {
      root.innerHTML = "";
      window.removeEventListener("resize", onResize);
    }

    function onResize() {
      if (!natW) return;
      var prev = { x: rect.x / dispW, y: rect.y / dispH, w: rect.w / dispW, h: rect.h / dispH };
      fitStage();
      rect = {
        x: prev.x * dispW,
        y: prev.y * dispH,
        w: prev.w * dispW,
        h: prev.h * dispH,
      };
      draw();
    }
    window.addEventListener("resize", onResize);

    box.querySelector("#crop-cancel").addEventListener("click", close);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });

    box.querySelector("#crop-apply").addEventListener("click", function () {
      // Map back to source pixels and cut at full resolution.
      var sx = Math.round(rect.x / scale);
      var sy = Math.round(rect.y / scale);
      var sw = Math.round(rect.w / scale);
      var sh = Math.round(rect.h / scale);
      sw = Math.max(1, Math.min(sw, natW - sx));
      sh = Math.max(1, Math.min(sh, natH - sy));

      var canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      var ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      // Encoded generously — this is re-encoded again downstream, and repeated
      // crops otherwise compound their losses.
      var dataUrl = canvas.toDataURL("image/jpeg", 0.95);
      close();
      onApply(dataUrl);
    });
  }

  window.WB = window.WB || {};
  window.WB.openCropper = openCropper;
})();
