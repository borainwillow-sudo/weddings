(function () {
  // Everything on a canvas — photos and text blocks alike — is an "item" with
  // the same {id, x, y, w} geometry, so one drag/snap/arrange engine serves
  // both. Blocks are found by [data-item-id]; photos additionally carry
  // [data-photo-id] for the things only a photo can do.
  //
  // All geometry is stored in percentages of the canvas WIDTH — including y —
  // so a layout keeps its exact proportions at any screen size.
  //
  // y therefore cannot be written to CSS `top` as a percentage: for an
  // absolutely positioned element a percentage top resolves against the
  // container's HEIGHT, and the container grows as photos are added, which
  // silently moved every existing photo. y is converted to pixels here
  // instead, and recomputed whenever the canvas width changes.
  var SNAP_PX = 6;
  var selectedId = null;
  var activeKeyHandler = null;

  function selectItem(canvas, id) {
    selectedId = id;
    canvas.querySelectorAll("[data-item-id]").forEach(function (el) {
      el.classList.toggle("selected", el.dataset.itemId === id);
    });
  }

  function clearSelection(canvas) {
    selectedId = null;
    if (!canvas) return;
    canvas.querySelectorAll(".selected").forEach(function (el) {
      el.classList.remove("selected");
    });
  }
  var MIN_WIDTH_PCT = 4;

  // A photo's height follows from its aspect ratio, but a text block's follows
  // from its content and the width it's been given, which only the browser
  // knows. applyPositions measures every block it lays out and records the
  // result here, so snapping and column packing have a real height to work
  // with. Keyed by item id, in percent of canvas width like everything else.
  var measuredHeight = {};
  var TEXT_HEIGHT_GUESS = 6;

  function aspect(photo) {
    if (!photo.width || !photo.height) return 1;
    // A quarter turn is applied when the photo is drawn rather than baked into
    // the file, so the stored width and height are still the original way
    // round — but the box the photo occupies on the page is not.
    var r = photo.rotate || 0;
    if (r === 90 || r === 270) return photo.width / photo.height;
    return photo.height / photo.width;
  }

  function heightPct(item) {
    if (item.type === "text") {
      var m = measuredHeight[item.id];
      return typeof m === "number" && m > 0 ? m : TEXT_HEIGHT_GUESS;
    }
    return item.w * aspect(item);
  }

  function contentBottom(items) {
    var max = 0;
    items.forEach(function (p) {
      var b = p.y + heightPct(p);
      if (b > max) max = b;
    });
    return max;
  }

  // Below this width the canvas either keeps the free-form arrangement,
  // shrunk to fit, or falls back to a plain stacked grid — see below.
  function isNarrow() {
    return window.matchMedia("(max-width: 820px)").matches;
  }

  // Reproducing the desktop arrangement on a phone means laying the canvas out
  // at a desktop width and scaling the whole thing down, rather than laying it
  // out narrow. Positions are proportional and would survive either way, but
  // text is sized in pixels: at a real 390px the captions would wrap
  // differently, text blocks would grow taller and the arrangement would no
  // longer be the one that was composed. Scaling shrinks type along with
  // everything else, so what you get is exactly the desktop page, smaller.
  //
  // 1100px is about what the canvas measures on a 1440px laptop, which is what
  // a layout is most likely to have been composed at.
  var PHONE_DESIGN_WIDTH = 1100;

  function isScaledPhone() {
    return isNarrow() && document.body.classList.contains("phone-desktop-layout");
  }

  function frameOf(canvas) {
    var p = canvas.parentElement;
    return p && p.classList.contains("canvas-frame") ? p : null;
  }

  // Lays items out and sizes the canvas to fit them.
  function applyPositions(canvas, items) {
    var blocks = canvas.querySelectorAll("[data-item-id]");
    var frame = frameOf(canvas);
    var scaled = isScaledPhone();

    // Anything left over from the other mode would fight with this one.
    canvas.style.transform = "";
    canvas.style.width = "";
    if (frame) frame.style.height = "";

    if (isNarrow() && !scaled) {
      // Hand layout back to the grid.
      canvas.style.height = "";
      blocks.forEach(function (el) {
        el.style.left = "";
        el.style.top = "";
        el.style.width = "";
      });
      return;
    }

    var width;
    if (scaled) {
      canvas.style.width = PHONE_DESIGN_WIDTH + "px";
      width = PHONE_DESIGN_WIDTH;
    } else {
      width = canvas.clientWidth;
    }

    blocks.forEach(function (el) {
      var item = items.find(function (p) {
        return p.id === el.dataset.itemId;
      });
      if (!item) return;
      el.style.left = item.x + "%";
      el.style.top = (item.y / 100) * width + "px";
      el.style.width = item.w + "%";
    });

    // Measure the real blocks rather than trusting the image ratios: a caption
    // adds height below the photo and would otherwise be clipped off the end.
    // The same pass records each block's height for heightPct above.
    var bottom = 0;
    blocks.forEach(function (el) {
      var b = el.offsetTop + el.offsetHeight;
      if (b > bottom) bottom = b;
      if (width) measuredHeight[el.dataset.itemId] = (el.offsetHeight / width) * 100;
    });
    canvas.style.height = bottom > 0 ? bottom + "px" : "";

    if (scaled && frame) {
      // Photos are free to hang past the canvas edges — on a desktop they
      // bleed into the page's side gutters and are seen in full. What gets
      // scaled to the phone's width is therefore the full extent of the
      // content, not the canvas: fitting the canvas alone would push that
      // bleed off the screen and cut the photos.
      var span = contentSpan(items);
      var leftPx = (span.left / 100) * PHONE_DESIGN_WIDTH;
      var k = frame.clientWidth / (((span.right - span.left) / 100) * PHONE_DESIGN_WIDTH);
      // Origin is the top-left, so the shift is applied in canvas coordinates
      // and scaled with everything else.
      canvas.style.transform = "scale(" + k + ") translateX(" + -leftPx + "px)";
      // A transform doesn't change the layout box, so the frame has to be told
      // how tall the shrunk canvas actually looks or the page scrolls wrong.
      frame.style.height = bottom > 0 ? bottom * k + "px" : "";
    }
  }

  // How far the content actually reaches sideways, in percent of canvas width.
  // Never narrower than the canvas itself, so a page whose photos all sit
  // inside it is unaffected.
  function contentSpan(items) {
    var left = 0;
    var right = 100;
    items.forEach(function (p) {
      if (p.x < left) left = p.x;
      if (p.x + p.w > right) right = p.x + p.w;
    });
    return { left: left, right: right };
  }

  function candidatesFor(items, movingId) {
    var vertical = [0, 50, 100];
    var horizontal = [0];
    items.forEach(function (p) {
      if (p.id === movingId) return;
      vertical.push(p.x, p.x + p.w / 2, p.x + p.w);
      var h = heightPct(p);
      horizontal.push(p.y, p.y + h / 2, p.y + h);
    });
    return { vertical: vertical, horizontal: horizontal };
  }

  // Finds the nearest guide for any of the moving box's edges.
  function snapAxis(edges, candidates, threshold) {
    var best = null;
    edges.forEach(function (edge) {
      candidates.forEach(function (c) {
        var delta = c - edge.value;
        if (Math.abs(delta) > threshold) return;
        if (!best || Math.abs(delta) < Math.abs(best.delta)) {
          best = { delta: delta, guide: c };
        }
      });
    });
    return best;
  }

  function renderGuides(overlay, vGuides, hGuides) {
    var html = "";
    vGuides.forEach(function (x) {
      html += '<div class="snap-guide snap-guide-v" style="left:' + x + '%"></div>';
    });
    hGuides.forEach(function (y) {
      html += '<div class="snap-guide snap-guide-h" style="top:' + y + '%"></div>';
    });
    overlay.innerHTML = html;
  }

  function enableEditing(canvas, items, onChange) {
    var overlay = canvas.querySelector(".snap-overlay");
    var active = null;
    var autoScrollFrame = null;

    // Dragging a photo to the far end of a page several screens tall is
    // impossible without this: holding near the top or bottom edge scrolls
    // the page, and the drag keeps up.
    var EDGE = 90;
    var MAX_SPEED = 22;

    function startAutoScroll() {
      if (autoScrollFrame) return;
      var step = function () {
        if (!active) {
          autoScrollFrame = null;
          return;
        }
        var y = active.clientY;
        var speed = 0;
        if (y < EDGE) speed = -MAX_SPEED * (1 - y / EDGE);
        else if (y > window.innerHeight - EDGE) {
          speed = MAX_SPEED * (1 - (window.innerHeight - y) / EDGE);
        }
        if (speed) {
          window.scrollBy(0, speed);
          updateFromPointer();
        }
        autoScrollFrame = requestAnimationFrame(step);
      };
      autoScrollFrame = requestAnimationFrame(step);
    }

    function stopAutoScroll() {
      if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
      autoScrollFrame = null;
    }

    function pctPerPx() {
      var rect = canvas.getBoundingClientRect();
      return rect.width ? 100 / rect.width : 0;
    }

    function onPointerDown(e) {
      // The tool buttons and the editable caption live inside the block, and
      // the preventDefault below would swallow their click and focus. Let
      // those through untouched. A text block is nearly all contenteditable,
      // which is why it carries a grip bar to drag by.
      if (
        e.target.closest(".photo-tools") ||
        e.target.closest(".link-flag") ||
        e.target.closest("[contenteditable]")
      ) {
        return;
      }
      var handle = e.target.closest(".resize-handle");
      var block = e.target.closest("[data-item-id]");
      if (!block || !canvas.contains(block)) return;
      var item = items.find(function (p) {
        return p.id === block.dataset.itemId;
      });
      if (!item) return;

      // The preventDefault below stops the browser moving focus, so a caption
      // or text block that is still being typed in would never fire focusout
      // and its edit would never be written down. Take focus away by hand.
      var open = document.activeElement;
      if (open && open.isContentEditable) open.blur();

      e.preventDefault();
      var scale = pctPerPx();
      active = {
        item: item,
        block: block,
        mode: handle ? "resize" : "move",
        startX: e.clientX,
        startY: e.clientY,
        origX: item.x,
        origY: item.y,
        origW: item.w,
        scale: scale,
        startScrollY: window.scrollY,
        clientX: e.clientX,
        clientY: e.clientY,
      };
      block.classList.add("dragging");
      block.setPointerCapture(e.pointerId);
      selectItem(canvas, item.id);
      startAutoScroll();
    }

    // Recomputed from the last known pointer position, so an auto-scroll can
    // drive it too without the pointer having moved.
    function updateFromPointer() {
      if (!active) return;
      applyDrag(active.clientX, active.clientY);
    }

    function onPointerMove(e) {
      if (!active) return;
      active.clientX = e.clientX;
      active.clientY = e.clientY;
      applyDrag(e.clientX, e.clientY);
    }

    function applyDrag(clientX, clientY) {
      var dxPct = (clientX - active.startX) * active.scale;
      // The page can scroll underneath a drag, so the photo has to follow the
      // document rather than the pointer alone.
      var dyPct =
        (clientY - active.startY + (window.scrollY - active.startScrollY)) *
        active.scale;
      var threshold = SNAP_PX * active.scale;
      var cands = candidatesFor(items, active.item.id);
      var vGuides = [];
      var hGuides = [];

      if (active.mode === "move") {
        var nx = active.origX + dxPct;
        var ny = active.origY + dyPct;
        var w = active.item.w;
        var h = heightPct(active.item);

        var vSnap = snapAxis(
          [
            { value: nx },
            { value: nx + w / 2 },
            { value: nx + w },
          ],
          cands.vertical,
          threshold
        );
        if (vSnap) {
          nx += vSnap.delta;
          vGuides.push(vSnap.guide);
        }

        var hSnap = snapAxis(
          [
            { value: ny },
            { value: ny + h / 2 },
            { value: ny + h },
          ],
          cands.horizontal,
          threshold
        );
        if (hSnap) {
          ny += hSnap.delta;
          hGuides.push(hSnap.guide);
        }

        active.item.x = Math.max(-w + MIN_WIDTH_PCT, Math.min(100 - MIN_WIDTH_PCT, nx));
        active.item.y = Math.max(0, ny);
      } else {
        var nw = active.origW + dxPct;
        nw = Math.max(MIN_WIDTH_PCT, Math.min(100 - active.item.x, nw));
        var rightEdge = active.item.x + nw;
        var rSnap = snapAxis([{ value: rightEdge }], cands.vertical, threshold);
        if (rSnap) {
          nw += rSnap.delta;
          nw = Math.max(MIN_WIDTH_PCT, nw);
          vGuides.push(rSnap.guide);
        }
        active.item.w = nw;
      }

      renderGuides(overlay, vGuides, hGuides);
      applyPositions(canvas, items);
    }

    function endDrag(e) {
      if (!active) return;
      stopAutoScroll();
      active.block.classList.remove("dragging");
      // Round so the saved JSON stays readable and diffs stay small.
      active.item.x = Math.round(active.item.x * 100) / 100;
      active.item.y = Math.round(active.item.y * 100) / 100;
      active.item.w = Math.round(active.item.w * 100) / 100;
      active = null;
      overlay.innerHTML = "";
      applyPositions(canvas, items);
      if (onChange) onChange();
    }

    // Arrow keys nudge the selected photo — far more precise than dragging,
    // especially for lining something up by a hair.
    function onKeyDown(e) {
      if (!selectedId) return;
      var dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      var d = dirs[e.key];
      if (!d) return;
      var target = items.find(function (p) {
        return p.id === selectedId;
      });
      if (!target) return;
      e.preventDefault();
      var stepPct = (e.shiftKey ? 2 : 0.25);
      target.x = Math.round((target.x + d[0] * stepPct) * 100) / 100;
      target.y = Math.max(0, Math.round((target.y + d[1] * stepPct) * 100) / 100);
      applyPositions(canvas, items);
      if (onChange) onChange();
    }
    if (activeKeyHandler) document.removeEventListener("keydown", activeKeyHandler);
    activeKeyHandler = onKeyDown;
    document.addEventListener("keydown", onKeyDown);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
  }

  var TOP_MARGIN = 4;
  var GAP = 4;
  var COLUMNS = 3;
  var COL_GAP = 2;
  var SIDE = 1;

  // Column x positions and width, as percentages of the canvas.
  function columnGeometry(n) {
    n = n || COLUMNS;
    var width = (100 - 2 * SIDE - (n - 1) * COL_GAP) / n;
    var xs = [];
    for (var i = 0; i < n; i++) xs.push(SIDE + i * (width + COL_GAP));
    return { width: Math.round(width * 100) / 100, xs: xs };
  }

  // One cursor per column, all starting below whatever is already there.
  function newColumnCursors(items, n) {
    var bottom = contentBottom(items);
    var start = bottom > 0 ? bottom + GAP : TOP_MARGIN;
    var cursors = [];
    for (var i = 0; i < (n || COLUMNS); i++) cursors.push(start);
    return cursors;
  }

  function shortestColumn(cursors) {
    var best = 0;
    for (var i = 1; i < cursors.length; i++) {
      if (cursors[i] < cursors[best]) best = i;
    }
    return best;
  }

  // Reflows every photo into columns, in their current order. Photos vary in
  // height, so each one goes to whichever column is currently shortest —
  // that's what stops one column running far ahead of the others.
  function arrangeInColumns(items, n) {
    n = n || COLUMNS;
    var geo = columnGeometry(n);
    var cursors = [];
    for (var i = 0; i < n; i++) cursors.push(TOP_MARGIN);
    items.forEach(function (p) {
      var col = shortestColumn(cursors);
      p.x = Math.round(geo.xs[col] * 100) / 100;
      p.y = Math.round(cursors[col] * 100) / 100;
      p.w = geo.width;
      cursors[col] += heightPct(p) + GAP;
    });
  }

  // Kept for callers that still want a single below-everything slot.
  function defaultPlacement(items) {
    var bottom = contentBottom(items);
    return {
      x: 8,
      y: bottom > 0 ? bottom + GAP : TOP_MARGIN,
      w: 34,
    };
  }

  // A new paragraph goes below everything, two columns wide. One column is a
  // sensible width for a photo but a cramped measure for prose.
  function defaultTextPlacement(items) {
    var geo = columnGeometry();
    var bottom = contentBottom(items);
    return {
      x: geo.xs[0],
      y: Math.round((bottom > 0 ? bottom + GAP : TOP_MARGIN) * 100) / 100,
      w: Math.round((geo.width * 2 + COL_GAP) * 100) / 100,
    };
  }

  // Reading order: down the page, then across. Used for the stacked phone
  // layout and as the input order for Arrange, so both follow the arrangement
  // on screen rather than the order things happened to be added in.
  function visualOrder(items) {
    return items.slice().sort(function (a, b) {
      return a.y - b.y || a.x - b.x;
    });
  }

  window.WB = window.WB || {};
  Object.assign(window.WB, {
    layout: {
      applyPositions: applyPositions,
      enableEditing: enableEditing,
      defaultPlacement: defaultPlacement,
      defaultTextPlacement: defaultTextPlacement,
      visualOrder: visualOrder,
      arrangeInColumns: arrangeInColumns,
      columnGeometry: columnGeometry,
      newColumnCursors: newColumnCursors,
      shortestColumn: shortestColumn,
      clearSelection: clearSelection,
      COLUMNS: COLUMNS,
      GAP: GAP,
      heightPct: heightPct,
      contentBottom: contentBottom,
    },
  });
})();
