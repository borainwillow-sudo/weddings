(function () {
  // Display version: large enough that it looks identical to the original on
  // any screen (including retina), but a fraction of the file size.
  var DISPLAY_MAX = 2560;
  var DISPLAY_QUALITY = 0.85;
  // Thumbnail: used in grids/free-form canvases so pages load fast.
  var THUMB_MAX = 800;
  var THUMB_QUALITY = 0.8;

  function loadImageFromFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that image file."));
      };
      img.src = url;
    });
  }

  function loadImageFromSrc(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error("Could not load that image."));
      };
      img.src = src;
    });
  }

  // Bakes a quarter/half turn into a new image file. Rotation is normally only
  // applied when a photo is drawn, but the cropper has to work on what is on
  // screen, so a rotated photo is turned upright-as-displayed before cropping.
  // Returns an object URL; the cropper revokes it once it has loaded.
  async function rotateToObjectUrl(src, degrees) {
    var img = await loadImageFromSrc(src);
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var quarter = degrees === 90 || degrees === 270;
    var canvas = document.createElement("canvas");
    canvas.width = quarter ? h : w;
    canvas.height = quarter ? w : h;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(img, -w / 2, -h / 2);
    var blob = await new Promise(function (resolve, reject) {
      canvas.toBlob(
        function (b) {
          if (!b) reject(new Error("The browser ran out of memory rotating this image."));
          else resolve(b);
          canvas.width = 0;
          canvas.height = 0;
        },
        "image/jpeg",
        0.95
      );
    });
    return URL.createObjectURL(blob);
  }

  function scaleTo(img, maxDim) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (w <= maxDim && h <= maxDim) return { w: w, h: h };
    if (w >= h) {
      return { w: maxDim, h: Math.round((h * maxDim) / w) };
    }
    return { w: Math.round((w * maxDim) / h), h: maxDim };
  }

  function renderToBlob(img, size, quality) {
    return new Promise(function (resolve, reject) {
      var canvas = document.createElement("canvas");
      canvas.width = size.w;
      canvas.height = size.h;
      var ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, size.w, size.h);
      canvas.toBlob(
        function (blob) {
          // toBlob hands back null when the browser can't encode the canvas —
          // most often memory pressure on iOS partway through a large batch.
          // Resolving with null used to let a photo into the page with no file
          // behind it: it never rendered and never published.
          if (!blob) {
            reject(new Error("The browser ran out of memory encoding this image."));
          } else {
            resolve(blob);
          }
          // Release the backing store promptly rather than waiting for GC.
          canvas.width = 0;
          canvas.height = 0;
        },
        "image/jpeg",
        quality
      );
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        // strip the "data:image/jpeg;base64," prefix
        var s = String(reader.result);
        resolve(s.slice(s.indexOf(",") + 1));
      };
      reader.readAsDataURL(blob);
    });
  }

  // Turns a user-selected file into the two derivatives we publish, plus the
  // metadata the layout engine needs (intrinsic aspect ratio).
  async function processFile(file) {
    var img = await loadImageFromFile(file);
    var displaySize = scaleTo(img, DISPLAY_MAX);
    var thumbSize = scaleTo(img, THUMB_MAX);

    var displayBlob = await renderToBlob(img, displaySize, DISPLAY_QUALITY);
    var thumbBlob = await renderToBlob(img, thumbSize, THUMB_QUALITY);

    var id = window.WB.uid();
    return {
      id: id,
      width: displaySize.w,
      height: displaySize.h,
      displayPath: "photos/" + id + ".jpg",
      thumbPath: "photos/" + id + "-t.jpg",
      displayBlob: displayBlob,
      thumbBlob: thumbBlob,
    };
  }

  // Re-encodes an already-cropped canvas result back into both derivatives.
  async function processDataUrl(dataUrl) {
    var img = await new Promise(function (resolve, reject) {
      var i = new Image();
      i.onload = function () {
        resolve(i);
      };
      i.onerror = reject;
      i.src = dataUrl;
    });
    var displaySize = scaleTo(img, DISPLAY_MAX);
    var thumbSize = scaleTo(img, THUMB_MAX);
    var displayBlob = await renderToBlob(img, displaySize, DISPLAY_QUALITY);
    var thumbBlob = await renderToBlob(img, thumbSize, THUMB_QUALITY);
    var id = window.WB.uid();
    return {
      id: id,
      width: displaySize.w,
      height: displaySize.h,
      displayPath: "photos/" + id + ".jpg",
      thumbPath: "photos/" + id + "-t.jpg",
      displayBlob: displayBlob,
      thumbBlob: thumbBlob,
    };
  }

  // Animated formats must never go through a canvas: drawImage captures a
  // single frame, so re-encoding silently flattens the animation to a still.
  // APNG is a PNG carrying an acTL chunk ahead of the first IDAT; GIF and
  // animated WebP are recognised by their own markers.
  async function detectAnimated(file) {
    var head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());

    function find(marker, from) {
      var m = [];
      for (var c = 0; c < marker.length; c++) m.push(marker.charCodeAt(c));
      outer: for (var i = from || 0; i <= head.length - m.length; i++) {
        for (var j = 0; j < m.length; j++) {
          if (head[i + j] !== m[j]) continue outer;
        }
        return i;
      }
      return -1;
    }

    var isPng =
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    if (isPng) {
      var actl = find("acTL");
      var idat = find("IDAT");
      return actl !== -1 && (idat === -1 || actl < idat);
    }
    if (find("GIF8") === 0) return true;
    if (find("RIFF") === 0 && find("WEBP") === 8) return find("ANIM") !== -1;
    return false;
  }

  // A wordmark logo is line art on transparency: PNG, and generous enough to
  // stay crisp on a retina screen at its displayed size. Animated files are
  // published exactly as uploaded so they keep moving.
  async function processLogoFile(file) {
    var img = await loadImageFromFile(file);

    if (await detectAnimated(file)) {
      var ext = (file.name.match(/\.(png|gif|webp)$/i) || [null, "png"])[1];
      var animId = window.WB.uid();
      return {
        id: animId,
        path: "logo/" + animId + "." + ext.toLowerCase(),
        blob: file,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        animated: true,
      };
    }

    var size = scaleTo(img, 1400);
    var canvas = document.createElement("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, size.w, size.h);
    var blob = await new Promise(function (resolve) {
      canvas.toBlob(resolve, "image/png");
    });
    var id = window.WB.uid();
    return {
      id: id,
      path: "logo/" + id + ".png",
      blob: blob,
      width: size.w,
      height: size.h,
    };
  }

  // Cursor artwork must keep its transparency, so this renders PNG rather than
  // JPEG. Browsers ignore cursor images larger than 128px, and sizes above
  // ~64px are unreliable across platforms, so the size is clamped.
  async function processCursorFile(file, size) {
    var img = await loadImageFromFile(file);
    var target = Math.max(8, Math.min(128, size || 32));
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var scale = Math.min(target / w, target / h);
    var outW = Math.max(1, Math.round(w * scale));
    var outH = Math.max(1, Math.round(h * scale));

    var canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, outW, outH);

    var blob = await new Promise(function (resolve) {
      canvas.toBlob(resolve, "image/png");
    });

    var id = window.WB.uid();
    return {
      id: id,
      path: "cursors/" + id + ".png",
      blob: blob,
      width: outW,
      height: outH,
    };
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  window.WB = window.WB || {};
  Object.assign(window.WB, {
    processFile: processFile,
    processDataUrl: processDataUrl,
    rotateToObjectUrl: rotateToObjectUrl,
    processCursorFile: processCursorFile,
    processLogoFile: processLogoFile,
    detectAnimated: detectAnimated,
    blobToBase64: blobToBase64,
    formatBytes: formatBytes,
  });
})();
