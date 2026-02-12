(function () {
  "use strict";

  // =========================================================================
  // KEYBINDING REGISTRY
  //
  // To add a new keybinding:
  //   1. Add an entry to KEYBINDINGS below.
  //   2. Each entry needs:
  //        key      – the keyboard key (lowercase)
  //        selector – CSS selector for the toolbar button to click
  //        label    – human-readable name shown in the toast
  //
  // The toolbar buttons in three-cad-viewer follow the pattern:
  //   <span class="tcv_button_frame">
  //     <input class="tcv_reset tcv_btn tcv_button_<NAME>" type="button">
  //   </span>
  //
  // When active, the frame span gets the class "tcv_btn_click2".
  // =========================================================================

  const KEYBINDINGS = [
    // Measurement tools
    { key: "u", shift: false, selector: "input.tcv_button_distance", label: "Distance Measurement" },
    { key: "u", shift: true,  selector: "input.tcv_button_properties", label: "Properties" },

    // --- Add more bindings here ---
  ];

  // Camera views: number + v
  const VIEW_MAP = {
    "0": { selector: "input.tcv_button_iso",    label: "Iso View" },
    "1": { selector: "input.tcv_button_front",  label: "Front View" },
    "2": { selector: "input.tcv_button_rear",   label: "Back View" },
    "3": { selector: "input.tcv_button_top",    label: "Top View" },
    "4": { selector: "input.tcv_button_bottom", label: "Bottom View" },
    "5": { selector: "input.tcv_button_left",   label: "Left View" },
    "6": { selector: "input.tcv_button_right",  label: "Right View" },
  };

  // v-prefix view options
  const V_PREFIX_MAP = {
    "t": { selector: "input.tcv_button_transparent", label: "Transparent", toggle: true },
    "e": { selector: "input.tcv_button_blackedges", label: "Black Edges", toggle: true },
    "g": { selector: "input.tcv_button_grid", label: "Grid", toggle: true },
    "a": { selector: "input.tcv_button_axes", label: "Axes", toggle: true },
    "o": { selector: "input.tcv_button_axes0", label: "Origin Axes", toggle: true },
    "p": { selector: "input.tcv_button_perspective", label: "Perspective", toggle: true },
    "x": { checkbox: "input.tcv_grid-xy", label: "Grid XY", toggle: true },
    "y": { checkbox: "input.tcv_grid-xz", label: "Grid XZ", toggle: true },
    "z": { checkbox: "input.tcv_grid-yz", label: "Grid YZ", toggle: true },
  };

  // Build a lookup map: "shift+key" or "key" -> binding
  const KEY_MAP = {};
  for (const binding of KEYBINDINGS) {
    var mapKey = (binding.shift ? "shift+" : "") + binding.key;
    KEY_MAP[mapKey] = binding;
  }

  // =========================================================================
  // Configuration
  // =========================================================================

  const ACTIVE_CLASS = "tcv_btn_click2";
  const FRAME_SELECTOR = ".tcv_button_frame";
  const TOAST_DURATION_MS = 1500;
  const POLL_INTERVAL_MS = 500;
  const MAX_POLL_ATTEMPTS = 60; // 30 seconds
  const MEASURE_VAL_SELECTOR = ".tcv_measure_val";
  const PRECISIONS = [8, 16, 32];
  const UNIT_POLL_MS = 400;
  const PROPERTIES_PANEL_SELECTOR = ".tcv_properties_measurement_panel";
  const DISTANCE_PANEL_SELECTOR = ".tcv_distance_measurement_panel";
  const COPY_BTN_POLL_MS = 300;

  // Yank keybind state (for multi-key sequences like "yy", "yx", "ybc")
  var yankSequence = [];  // array of keys pressed
  var lastKeyTime = 0;
  const YANK_SEQUENCE_TIMEOUT_MS = 1500;
  var whichKeyEl = null;
  var whichKeyTimer = null;

  // Number-prefix sequence state (for Nv, Nh, Ny, N{x|y|z}y sequences)
  var numPrefix = "";     // buffered digit(s)
  var numAxis = "";       // buffered axis letter (x, y, or z) for N{axis}y
  var numPrefixTime = 0;
  const NUM_PREFIX_TIMEOUT_MS = 1500;

  // v-prefix sequence state (for vt, ve, vg, etc.)
  var vPrefixActive = false;
  var vPrefixTime = 0;

  // =========================================================================
  // Unit Conversion State (session-only, resets on page load)
  // =========================================================================

  var currentUnit = "mm";       // "mm" or "inch"
  var currentPrecision = 16;    // denominator: 8, 16, or 32
  var useFeet = false;          // when true, show feet+inches for >= 12"
  var toolbarEl = null;
  var unitPollTimer = null;
  var cellMmCache = new WeakMap();   // cell -> mm value
  var cellTextCache = new WeakMap(); // cell -> last text we wrote

  // =========================================================================
  // Fractional Inch Conversion
  // =========================================================================

  function gcd(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      var t = b;
      b = a % b;
      a = t;
    }
    return a;
  }

  function mmToFractionalInches(mm, denominator) {
    var totalInches = mm / 25.4;
    var negative = totalInches < 0;
    totalInches = Math.abs(totalInches);

    var totalParts = Math.round(totalInches * denominator);
    var wholeInches = Math.floor(totalParts / denominator);
    var numerator = totalParts - wholeInches * denominator;

    var dispDenom = denominator;
    if (numerator > 0) {
      var g = gcd(numerator, denominator);
      numerator = numerator / g;
      dispDenom = denominator / g;
    }

    var feet = useFeet ? Math.floor(wholeInches / 12) : 0;
    var inches = useFeet ? wholeInches % 12 : wholeInches;

    var parts = [];
    if (negative) parts.push("-");

    if (feet > 0) {
      parts.push(feet + "'");
      if (inches > 0 || numerator > 0) parts.push(" ");
    }

    if (inches > 0 || (feet === 0 && numerator === 0)) {
      parts.push(inches);
      if (numerator > 0) {
        parts.push(" ");
      } else {
        parts.push('"');
      }
    }

    if (numerator > 0) {
      parts.push(numerator + "/" + dispDenom + '"');
    }

    return parts.join("");
  }

  // =========================================================================
  // Measurement Cell Rewriting (direct textContent replacement)
  // Original mm values stored in a WeakMap — no DOM attributes added.
  // =========================================================================

  function isAngleRow(cell) {
    var row = cell.closest("tr");
    if (!row) return false;
    var headers = row.querySelectorAll("th");
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].textContent.trim().toLowerCase() === "angle") return true;
    }
    return false;
  }

  function convertAllCells() {
    var cells = document.querySelectorAll(MEASURE_VAL_SELECTOR);
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (isAngleRow(cell)) continue;

      var text = cell.textContent.trim();

      // If we have a stored original, check if the viewer overwrote our value.
      // Compare against the last text we wrote — not a recomputed value,
      // since the precision may have changed since we last wrote.
      if (cellMmCache.has(cell)) {
        var lastWritten = cellTextCache.get(cell);
        if (text !== lastWritten) {
          // Viewer wrote something new — discard our cache
          cellMmCache.delete(cell);
          cellTextCache.delete(cell);
        }
      }

      // Capture original mm value if not yet stored
      if (!cellMmCache.has(cell)) {
        var parsed = parseFloat(text);
        if (isNaN(parsed)) continue;
        cellMmCache.set(cell, parsed);
      }

      var originalMm = cellMmCache.get(cell);
      var newText;

      if (currentUnit === "inch") {
        newText = mmToFractionalInches(originalMm, currentPrecision);
      } else {
        newText = originalMm.toFixed(3);
      }

      // Only write if the text actually changed (avoid unnecessary DOM mutations
      // that can trigger the viewer's MutationObserver feedback loop)
      if (cell.textContent !== newText) {
        cell.textContent = newText;
      }
      cellTextCache.set(cell, newText);
    }
  }

  function restoreAllCells() {
    var cells = document.querySelectorAll(MEASURE_VAL_SELECTOR);
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (cellMmCache.has(cell)) {
        var mmText = cellMmCache.get(cell).toFixed(3);
        if (cell.textContent !== mmText) {
          cell.textContent = mmText;
        }
        cellTextCache.set(cell, mmText);
        cellMmCache.delete(cell);
      }
    }
  }

  // =========================================================================
  // Polling — detect when viewer updates values or adds/removes cells
  // Only active while in inch mode.
  // =========================================================================

  function startUnitPoll() {
    if (unitPollTimer) return;
    unitPollTimer = setInterval(function () {
      if (currentUnit !== "inch") return;

      var cells = document.querySelectorAll(MEASURE_VAL_SELECTOR);
      if (cells.length === 0) return;

      var needsUpdate = false;
      for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        if (isAngleRow(cell)) continue;

        // New cell we haven't seen
        if (!cellMmCache.has(cell)) {
          needsUpdate = true;
          break;
        }

        // Check if viewer overwrote our converted value
        var text = cell.textContent.trim();
        var lastWritten = cellTextCache.get(cell);
        if (text !== lastWritten) {
          cellMmCache.delete(cell);
          cellTextCache.delete(cell);
          needsUpdate = true;
          break;
        }
      }

      if (needsUpdate) {
        convertAllCells();
      }
    }, UNIT_POLL_MS);
  }

  function stopUnitPoll() {
    if (unitPollTimer) {
      clearInterval(unitPollTimer);
      unitPollTimer = null;
    }
  }

  // =========================================================================
  // Unit switching
  // =========================================================================

  function switchUnit(newUnit) {
    if (newUnit === currentUnit) return;
    currentUnit = newUnit;
    updateToolbar();

    if (currentUnit === "inch") {
      convertAllCells();
      startUnitPoll();
    } else {
      restoreAllCells();
      stopUnitPoll();
    }
  }

  // =========================================================================
  // Unit / Precision Toolbar UI (bottom-right corner)
  // =========================================================================

  function styleToolbarButton(btn, active) {
    Object.assign(btn.style, {
      padding: "4px 8px",
      border: "1px solid " + (active ? "#228b22" : "#888"),
      borderRadius: "4px",
      background: active ? "#228b22" : "#2a2a2a",
      color: active ? "#fff" : "#ccc",
      cursor: "pointer",
      fontSize: "12px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontWeight: active ? "700" : "400",
      outline: "none",
      lineHeight: "1",
    });
  }

  function updateToolbar() {
    if (!toolbarEl) return;

    var unitBtn = toolbarEl.querySelector("#ocp-unit-btn");
    unitBtn.textContent = currentUnit === "mm" ? "mm" : "inch";
    styleToolbarButton(unitBtn, currentUnit === "inch");

    var precBtns = toolbarEl.querySelectorAll(".ocp-prec-btn");
    for (var i = 0; i < precBtns.length; i++) {
      var btn = precBtns[i];
      var denom = parseInt(btn.getAttribute("data-precision"), 10);
      btn.style.display = currentUnit === "inch" ? "inline-block" : "none";
      styleToolbarButton(btn, denom === currentPrecision);
    }

    var feetBtn = toolbarEl.querySelector("#ocp-feet-btn");
    if (feetBtn) {
      feetBtn.style.display = currentUnit === "inch" ? "inline-block" : "none";
      styleToolbarButton(feetBtn, useFeet);
    }
  }

  function createToolbar() {
    if (toolbarEl) return;

    toolbarEl = document.createElement("div");
    toolbarEl.id = "ocp-unit-toolbar";
    Object.assign(toolbarEl.style, {
      position: "fixed",
      bottom: "12px",
      right: "12px",
      display: "flex",
      gap: "4px",
      alignItems: "center",
      zIndex: "999998",
      pointerEvents: "none",  // let clicks pass through by default
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "12px",
    });

    var unitBtn = document.createElement("button");
    unitBtn.id = "ocp-unit-btn";
    unitBtn.textContent = "mm";
    unitBtn.style.pointerEvents = "auto"; // only buttons are clickable
    styleToolbarButton(unitBtn, false);
    unitBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      switchUnit(currentUnit === "mm" ? "inch" : "mm");
      showToast("Units: " + (currentUnit === "mm" ? "mm" : "inches"), true);
    });
    toolbarEl.appendChild(unitBtn);

    for (var p = 0; p < PRECISIONS.length; p++) {
      (function (denom) {
        var btn = document.createElement("button");
        btn.className = "ocp-prec-btn";
        btn.setAttribute("data-precision", denom);
        btn.textContent = "1/" + denom;
        btn.style.pointerEvents = "auto";
        styleToolbarButton(btn, false);
        btn.style.display = "none";
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          currentPrecision = denom;
          updateToolbar();
          convertAllCells();
          showToast('Precision: 1/' + denom + '"', true);
        });
        toolbarEl.appendChild(btn);
      })(PRECISIONS[p]);
    }

    // Feet toggle (visible only in inch mode)
    var feetBtn = document.createElement("button");
    feetBtn.id = "ocp-feet-btn";
    feetBtn.textContent = "ft";
    feetBtn.style.pointerEvents = "auto";
    styleToolbarButton(feetBtn, false);
    feetBtn.style.display = "none";
    feetBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      useFeet = !useFeet;
      updateToolbar();
      convertAllCells();
      showToast("Feet: " + (useFeet ? "ON" : "OFF"), useFeet);
    });
    toolbarEl.appendChild(feetBtn);

    document.body.appendChild(toolbarEl);
    updateToolbar();
  }

  // =========================================================================
  // Copy Buttons for Properties and Distance Panels
  // =========================================================================

  var copyBtnPollTimer = null;

  // Get cell value (original mm if cached, otherwise parse displayed text)
  function getCellValue(cell) {
    if (!cell) return NaN;
    return cellMmCache.has(cell) ? cellMmCache.get(cell) : parseFloat(cell.textContent);
  }

  // Copy coordinates (x, y, z) from a row
  function copyCoords(row, label) {
    var xCell = row.querySelector(".tcv_x_measure_val");
    var yCell = row.querySelector(".tcv_y_measure_val");
    var zCell = row.querySelector(".tcv_z_measure_val");

    if (!xCell || !yCell || !zCell) {
      showToast("Could not find coordinates", false);
      return;
    }

    var x = getCellValue(xCell);
    var y = getCellValue(yCell);
    var z = getCellValue(zCell);

    var coords = x.toFixed(3) + ", " + y.toFixed(3) + ", " + z.toFixed(3);

    navigator.clipboard.writeText(coords).then(function () {
      showToast("Copied " + label + ": " + coords, true);
    }).catch(function () {
      showToast("Copy failed", false);
    });
  }

  // Copy a single value from a row
  function copySingleValue(row, label) {
    // Find the single tcv_measure_val cell (not x/y/z)
    var cells = row.querySelectorAll(".tcv_measure_val");
    var valueCell = null;
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (!cell.classList.contains("tcv_x_measure_val") &&
          !cell.classList.contains("tcv_y_measure_val") &&
          !cell.classList.contains("tcv_z_measure_val")) {
        valueCell = cell;
        break;
      }
    }

    if (!valueCell) {
      showToast("Could not find value", false);
      return;
    }

    var val = getCellValue(valueCell);
    var text = val.toFixed(3);

    navigator.clipboard.writeText(text).then(function () {
      showToast("Copied " + label + ": " + text, true);
    }).catch(function () {
      showToast("Copy failed", false);
    });
  }

  // Check if row is a Reference row (should not get copy button)
  function isReferenceRow(row) {
    var th = row.querySelector("th.tcv_measure_key");
    if (!th) return false;
    var label = th.textContent.trim().toLowerCase();
    return label.startsWith("reference");
  }

  // =========================================================================
  // Copy Button Overlay System
  //
  // IMPORTANT: Copy buttons are placed in a separate overlay container
  // OUTSIDE the viewer's measurement panels. This prevents our DOM
  // modifications from triggering the viewer's MutationObserver, which
  // would cause an infinite feedback loop:
  //   our DOM change -> viewer observer fires -> viewer re-requests data
  //   -> backend responds -> viewer rebuilds panel -> we add buttons again
  //   -> viewer observer fires -> ...
  //
  // Instead, we position absolute buttons that visually appear next to
  // the panel rows but live in a separate DOM subtree.
  // =========================================================================

  var overlayContainer = null;
  var lastOverlaySignature = "";

  function getOverlayContainer() {
    if (!overlayContainer) {
      overlayContainer = document.createElement("div");
      overlayContainer.id = "ocp-copy-overlay";
      Object.assign(overlayContainer.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "0",
        height: "0",
        overflow: "visible",
        pointerEvents: "none",
        zIndex: "999997",
      });
      document.body.appendChild(overlayContainer);
    }
    return overlayContainer;
  }

  function createOverlayCopyButton(label, clickHandler) {
    var btn = document.createElement("button");
    btn.className = "ocp-copy-overlay-btn";
    btn.textContent = "\u{1F4CB}";
    btn.title = "Copy " + label;
    Object.assign(btn.style, {
      position: "absolute",
      padding: "2px 5px",
      border: "1px solid #666",
      borderRadius: "3px",
      background: "#333",
      color: "#fff",
      cursor: "pointer",
      fontSize: "10px",
      lineHeight: "1",
      pointerEvents: "auto",
      opacity: "0.8",
    });

    btn.addEventListener("mouseenter", function () {
      btn.style.opacity = "1";
    });
    btn.addEventListener("mouseleave", function () {
      btn.style.opacity = "0.8";
    });

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      clickHandler();
    });

    return btn;
  }

  function buildOverlaySignature() {
    // Build a signature from visible panel content to detect real changes
    var sig = "";
    var panels = document.querySelectorAll(PROPERTIES_PANEL_SELECTOR + ", " + DISTANCE_PANEL_SELECTOR);
    for (var i = 0; i < panels.length; i++) {
      var panel = panels[i];
      if (panel.style.display === "none") continue;
      var rows = panel.querySelectorAll("tr");
      for (var j = 0; j < rows.length; j++) {
        var th = rows[j].querySelector("th.tcv_measure_key");
        if (th) sig += th.textContent.trim() + ";";
      }
      sig += "|";
    }
    return sig;
  }

  function updateCopyButtonOverlay() {
    // Only rebuild if panel content actually changed
    var sig = buildOverlaySignature();
    if (sig === lastOverlaySignature) return;
    lastOverlaySignature = sig;

    var container = getOverlayContainer();
    // Clear old buttons
    container.innerHTML = "";

    var panels = document.querySelectorAll(PROPERTIES_PANEL_SELECTOR + ", " + DISTANCE_PANEL_SELECTOR);

    for (var i = 0; i < panels.length; i++) {
      var panel = panels[i];
      if (panel.style.display === "none") continue;

      var rows = panel.querySelectorAll("tr");
      for (var j = 0; j < rows.length; j++) {
        var row = rows[j];
        var th = row.querySelector("th.tcv_measure_key");
        if (!th) continue;
        if (isReferenceRow(row)) continue;

        var xCell = row.querySelector(".tcv_x_measure_val");
        var yCell = row.querySelector(".tcv_y_measure_val");
        var zCell = row.querySelector(".tcv_z_measure_val");
        var hasCoords = xCell && yCell && zCell;

        // Position a copy button to the left of the row header
        var thRect = th.getBoundingClientRect();

        if (hasCoords) {
          // Row-level copy (all coords)
          (function (r) {
            var btn = createOverlayCopyButton("coordinates", function () {
              var label = r.querySelector("th.tcv_measure_key");
              var lbl = label ? label.textContent.trim() : "value";
              copyCoords(r, lbl);
            });
            btn.style.top = (thRect.top + thRect.height / 2 - 8) + "px";
            btn.style.left = (thRect.left - 24) + "px";
            container.appendChild(btn);
          })(row);
        } else {
          // Single value copy
          (function (r) {
            var btn = createOverlayCopyButton("value", function () {
              var label = r.querySelector("th.tcv_measure_key");
              var lbl = label ? label.textContent.trim() : "value";
              copySingleValue(r, lbl);
            });
            btn.style.top = (thRect.top + thRect.height / 2 - 8) + "px";
            btn.style.left = (thRect.left - 24) + "px";
            container.appendChild(btn);
          })(row);
        }
      }
    }
  }

  function startCopyBtnPoll() {
    if (copyBtnPollTimer) return;
    // Poll at a moderate rate but NEVER modify the viewer's panel DOM.
    // We only read positions and update our external overlay.
    copyBtnPollTimer = setInterval(updateCopyButtonOverlay, COPY_BTN_POLL_MS);
  }

  // =========================================================================
  // Yank Keybindings - Row-based system
  //
  // Sequences:
  //   yy         — yank primary value (first row of visible panel)
  //   0y         — yank whole table as text
  //   Ny         — yank row N values (comma-separated if xyz)
  //   N{x|y|z}y  — yank specific axis of row N ("Wrong yank" if single-value row)
  //
  // Number prefix is handled by the existing numPrefix system in handleKeyDown.
  // =========================================================================

  // Get the visible panel (distance takes priority over properties)
  function getVisiblePanel() {
    var distPanel = document.querySelector(DISTANCE_PANEL_SELECTOR);
    if (distPanel && distPanel.style.display !== "none") return distPanel;
    var propPanel = document.querySelector(PROPERTIES_PANEL_SELECTOR);
    if (propPanel && propPanel.style.display !== "none") return propPanel;
    return null;
  }

  // Get all data rows from a panel's table
  function getPanelRows(panel) {
    if (!panel) return [];
    var rows = panel.querySelectorAll("tr");
    var result = [];
    for (var i = 0; i < rows.length; i++) {
      var th = rows[i].querySelector("th.tcv_measure_key");
      if (th) result.push(rows[i]);
    }
    return result;
  }

  // Get row label text
  function getRowLabel(row) {
    var th = row.querySelector("th.tcv_measure_key");
    return th ? th.textContent.trim() : "";
  }

  // Check if a row has xyz coordinate cells
  function rowHasCoords(row) {
    return row.querySelector(".tcv_x_measure_val") &&
           row.querySelector(".tcv_y_measure_val") &&
           row.querySelector(".tcv_z_measure_val");
  }

  // Format row values as text: "label: value" or "label: x, y, z"
  function formatRowText(row) {
    var label = getRowLabel(row);
    if (rowHasCoords(row)) {
      var x = getCellValue(row.querySelector(".tcv_x_measure_val"));
      var y = getCellValue(row.querySelector(".tcv_y_measure_val"));
      var z = getCellValue(row.querySelector(".tcv_z_measure_val"));
      return label + ": " + x.toFixed(3) + ", " + y.toFixed(3) + ", " + z.toFixed(3);
    }
    // Single value
    var cells = row.querySelectorAll(".tcv_measure_val");
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (!cell.classList.contains("tcv_x_measure_val") &&
          !cell.classList.contains("tcv_y_measure_val") &&
          !cell.classList.contains("tcv_z_measure_val")) {
        var val = getCellValue(cell);
        return label + ": " + val.toFixed(3);
      }
    }
    return label + ": ?";
  }

  // Format row values only (no label): "value" or "x, y, z"
  function formatRowValues(row) {
    if (rowHasCoords(row)) {
      var x = getCellValue(row.querySelector(".tcv_x_measure_val"));
      var y = getCellValue(row.querySelector(".tcv_y_measure_val"));
      var z = getCellValue(row.querySelector(".tcv_z_measure_val"));
      return x.toFixed(3) + ", " + y.toFixed(3) + ", " + z.toFixed(3);
    }
    var cells = row.querySelectorAll(".tcv_measure_val");
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (!cell.classList.contains("tcv_x_measure_val") &&
          !cell.classList.contains("tcv_y_measure_val") &&
          !cell.classList.contains("tcv_z_measure_val")) {
        return getCellValue(cell).toFixed(3);
      }
    }
    return "?";
  }

  // Yank whole table as formatted text (0y)
  function yankWholeTable() {
    var panel = getVisiblePanel();
    if (!panel) {
      showToast("No panel visible", false);
      return;
    }
    var rows = getPanelRows(panel);
    var lines = [];
    for (var i = 0; i < rows.length; i++) {
      lines.push(formatRowText(rows[i]));
    }
    var text = lines.join("\n");
    navigator.clipboard.writeText(text).then(function () {
      showToast("Copied table (" + rows.length + " rows)", true);
    }).catch(function () {
      showToast("Copy failed", false);
    });
  }

  // Yank row N values (Ny)
  function yankRowN(n) {
    var panel = getVisiblePanel();
    if (!panel) {
      showToast("No panel visible", false);
      return;
    }
    var rows = getPanelRows(panel);
    if (n < 1 || n > rows.length) {
      showToast("Row " + n + " not found (only " + rows.length + " rows)", false);
      return;
    }
    var row = rows[n - 1];
    var label = getRowLabel(row);
    var values = formatRowValues(row);
    navigator.clipboard.writeText(values).then(function () {
      showToast("Copied " + label + ": " + values, true);
    }).catch(function () {
      showToast("Copy failed", false);
    });
  }

  // Yank specific axis of row N (N{x|y|z}y)
  function yankRowAxis(n, axis) {
    var panel = getVisiblePanel();
    if (!panel) {
      showToast("No panel visible", false);
      return;
    }
    var rows = getPanelRows(panel);
    if (n < 1 || n > rows.length) {
      showToast("Row " + n + " not found (only " + rows.length + " rows)", false);
      return;
    }
    var row = rows[n - 1];
    if (!rowHasCoords(row)) {
      navigator.clipboard.writeText("Wrong yank").then(function () {
        showToast("Wrong yank — single value row", false);
      }).catch(function () {
        showToast("Copy failed", false);
      });
      return;
    }
    var cellClass = ".tcv_" + axis + "_measure_val";
    var cell = row.querySelector(cellClass);
    if (!cell) {
      showToast(axis.toUpperCase() + " not found", false);
      return;
    }
    var val = getCellValue(cell);
    var text = val.toFixed(3);
    var label = getRowLabel(row);
    navigator.clipboard.writeText(text).then(function () {
      showToast("Copied " + label + " " + axis.toUpperCase() + ": " + text, true);
    }).catch(function () {
      showToast("Copy failed", false);
    });
  }

  // Yank primary value (yy) — first row of visible panel
  function yankPrimary() {
    var panel = getVisiblePanel();
    if (!panel) {
      showToast("No panel visible", false);
      return;
    }
    var rows = getPanelRows(panel);
    if (rows.length === 0) {
      showToast("No data rows", false);
      return;
    }
    var row = rows[0];
    var label = getRowLabel(row);
    var values = formatRowValues(row);
    navigator.clipboard.writeText(values).then(function () {
      showToast("Copied " + label + ": " + values, true);
    }).catch(function () {
      showToast("Copy failed", false);
    });
  }

  // =========================================================================
  // Which-Key Panel (shows available yank commands)
  // =========================================================================

  function createWhichKeyPanel() {
    if (whichKeyEl) return whichKeyEl;

    whichKeyEl = document.createElement("div");
    whichKeyEl.id = "ocp-whichkey-panel";
    Object.assign(whichKeyEl.style, {
      position: "fixed",
      bottom: "44px",
      right: "12px",
      padding: "12px 16px",
      borderRadius: "8px",
      fontSize: "13px",
      fontFamily: "monospace",
      color: "#e0e0e0",
      backgroundColor: "rgba(30, 30, 30, 0.95)",
      border: "1px solid #444",
      zIndex: "999999",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 0.15s ease-in-out",
      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.4)",
    });

    document.body.appendChild(whichKeyEl);
    return whichKeyEl;
  }

  function renderWhichKeyOption(key, label, dim) {
    var keyStyle = "display: inline-block; min-width: 18px; padding: 2px 5px; background: " +
                   (dim ? "#333" : "#444") + "; border-radius: 3px; margin-right: 8px; text-align: center; color: " +
                   (dim ? "#666" : "#fff") + "; font-size: 11px;";
    var labelStyle = dim ? "color: #555;" : "color: #bbb;";
    return '<div style="display: flex; align-items: center; margin: 2px 0;">' +
           '<span style="' + keyStyle + '">' + key + '</span>' +
           '<span style="' + labelStyle + '">' + label + '</span>' +
           '</div>';
  }

  function showWhichKey(mode) {
    var panel = createWhichKeyPanel();

    var distPanel = document.querySelector(DISTANCE_PANEL_SELECTOR);
    var propPanel = document.querySelector(PROPERTIES_PANEL_SELECTOR);
    var distVisible = distPanel && distPanel.style.display !== "none";
    var propVisible = propPanel && propPanel.style.display !== "none";

    // Detect panel type from subheader
    var panelType = "none";
    if (propVisible) {
      var subheader = propPanel.querySelector(".tcv_measure_subheader");
      if (subheader) {
        var text = subheader.textContent.toLowerCase();
        if (text.indexOf("vertex") !== -1 || text.indexOf("point") !== -1) panelType = "vertex";
        else if (text.indexOf("edge") !== -1) panelType = "edge";
        else if (text.indexOf("face") !== -1 || text.indexOf("plane") !== -1) panelType = "face";
      }
    }

    var html = "";

    if (mode === "view") {
      // View prefix menu
      html = '<div style="color: #888; margin-bottom: 6px; font-size: 11px;">View:</div>';
      html += '<div style="display: flex; gap: 16px;">';
      html += '<div>';
      html += renderWhichKeyOption("t", "Transparent", false);
      html += renderWhichKeyOption("e", "Black Edges", false);
      html += renderWhichKeyOption("a", "Axes", false);
      html += renderWhichKeyOption("o", "Origin Axes", false);
      html += renderWhichKeyOption("p", "Perspective", false);
      html += '</div><div>';
      html += renderWhichKeyOption("g", "Grid", false);
      html += renderWhichKeyOption("x", "Grid XY", false);
      html += renderWhichKeyOption("y", "Grid XZ", false);
      html += renderWhichKeyOption("z", "Grid YZ", false);
      html += '</div>';
      html += '</div>';
    } else if (mode === "numprefix") {
      // Number prefix menu — show what the digit can do
      html = '<div style="color: #888; margin-bottom: 6px; font-size: 11px;">' + numPrefix + ' +</div>';
      html += '<div>';
      html += renderWhichKeyOption("v", "View", false);
      html += renderWhichKeyOption("h", "Hide/Show", false);
      html += renderWhichKeyOption("y", "Yank row", false);
      html += renderWhichKeyOption("x", "Yank X then y", false);
      html += '</div>';
    } else if (mode === "numaxis") {
      // Number + axis, waiting for 'y' to confirm
      html = '<div style="color: #888; margin-bottom: 6px; font-size: 11px;">' + numPrefix + numAxis + ' +</div>';
      html += '<div>';
      html += renderWhichKeyOption("y", "Yank", false);
      html += '</div>';
    } else {
      // yy — just show that y yanks primary
      var visPanel = getVisiblePanel();
      var rows = visPanel ? getPanelRows(visPanel) : [];
      var firstLabel = rows.length > 0 ? getRowLabel(rows[0]) : "?";
      html = '<div style="color: #888; margin-bottom: 6px; font-size: 11px;">Yank:</div>';
      html += '<div>';
      html += renderWhichKeyOption("y", firstLabel, rows.length === 0);
      html += '</div>';
    }

    panel.innerHTML = html;
    panel.style.opacity = "1";

    // Auto-hide after timeout
    var timeout = (mode === "view" || mode === "numprefix" || mode === "numaxis")
                    ? NUM_PREFIX_TIMEOUT_MS : YANK_SEQUENCE_TIMEOUT_MS;
    if (whichKeyTimer) clearTimeout(whichKeyTimer);
    whichKeyTimer = setTimeout(function () {
      // If axis was 'y' and timed out, treat as row yank (Ny)
      if (numAxis === "y" && numPrefix !== "") {
        var num = parseInt(numPrefix, 10);
        numPrefix = "";
        numAxis = "";
        hideWhichKey();
        if (num === 0) {
          yankWholeTable();
        } else {
          yankRowN(num);
        }
        return;
      }
      hideWhichKey();
      yankSequence = [];
      lastKeyTime = 0;
      numPrefix = "";
      numAxis = "";
      vPrefixActive = false;
    }, timeout);
  }

  function hideWhichKey() {
    if (whichKeyEl) {
      whichKeyEl.style.opacity = "0";
    }
    if (whichKeyTimer) {
      clearTimeout(whichKeyTimer);
      whichKeyTimer = null;
    }
  }

  // =========================================================================
  // Tree Node Hide/Show (Nh = toggle Nth node, 0h = toggle all)
  // =========================================================================

  function getTreeNodes() {
    // Get direct child nodes under the top-level group
    var container = document.querySelector(".tcv_cad_tree_container");
    if (!container) return [];

    // The top-level node is always /Group — its children are the actual shapes
    var topNode = container.querySelector('.tv-tree-node[data-path="/Group"]');
    if (!topNode) {
      // Fallback: try the first top-level node
      topNode = container.querySelector(".tv-tree-node");
    }
    if (!topNode) return [];

    var childrenContainer = topNode.querySelector(".tv-children");
    if (!childrenContainer) return [];

    // Direct child .tv-tree-node elements
    var nodes = [];
    var children = childrenContainer.children;
    for (var i = 0; i < children.length; i++) {
      if (children[i].classList.contains("tv-tree-node")) {
        nodes.push(children[i]);
      }
    }
    return nodes;
  }

  function toggleTreeNodeVisibility(node) {
    // Click the shape icon (.tv-icon0) to toggle visibility
    var icon = node.querySelector(".tv-node-content .tv-icon0");
    if (icon) {
      icon.click();
      return true;
    }
    return false;
  }

  function getTreeNodeLabel(node) {
    var label = node.querySelector(".tv-node-label");
    if (!label) return "?";
    // Get text without the colored dot span
    var text = "";
    for (var i = 0; i < label.childNodes.length; i++) {
      if (label.childNodes[i].nodeType === Node.TEXT_NODE) {
        text += label.childNodes[i].textContent;
      }
    }
    return text.trim() || label.textContent.trim();
  }

  function isTreeNodeVisible(node) {
    var icon = node.querySelector(".tv-node-content .tv-icon0");
    if (!icon) return false;
    // If the icon has tcv_button_shape (not _no or _mix), it's visible
    return icon.classList.contains("tcv_button_shape");
  }

  function handleHideByNumber(num) {
    if (num === 0) {
      // Toggle all: click the top-level Group's shape icon
      var container = document.querySelector(".tcv_cad_tree_container");
      if (!container) {
        showToast("No CAD tree found", false);
        return;
      }
      var topNode = container.querySelector('.tv-tree-node[data-path="/Group"]');
      if (!topNode) topNode = container.querySelector(".tv-tree-node");
      if (!topNode) {
        showToast("No tree node found", false);
        return;
      }
      var toggled = toggleTreeNodeVisibility(topNode);
      if (toggled) {
        showToast("Toggle All", true);
      }
      return;
    }

    var nodes = getTreeNodes();
    if (num > nodes.length) {
      showToast("Node " + num + " not found (only " + nodes.length + " nodes)", false);
      return;
    }
    var node = nodes[num - 1];
    var label = getTreeNodeLabel(node);
    var wasVisible = isTreeNodeVisible(node);
    toggleTreeNodeVisibility(node);
    showToast(label + (wasVisible ? " hidden" : " shown"), !wasVisible);
  }

  // =========================================================================
  // Toast notification
  // =========================================================================

  let toastEl = null;
  let toastTimer = null;

  function getToast() {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "ocp-keybind-toast";
      Object.assign(toastEl.style, {
        position: "fixed",
        bottom: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        padding: "8px 18px",
        borderRadius: "6px",
        fontSize: "14px",
        fontWeight: "600",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#fff",
        zIndex: "999999",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity 0.2s ease-in-out",
      });
      document.body.appendChild(toastEl);
    }
    return toastEl;
  }

  function showToast(message, isActive) {
    var el = getToast();
    el.style.backgroundColor = isActive
      ? "rgba(34, 139, 34, 0.9)"
      : "rgba(80, 80, 80, 0.9)";
    el.textContent = message;
    el.style.opacity = "1";

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.style.opacity = "0";
    }, TOAST_DURATION_MS);
  }

  // =========================================================================
  // Button helpers
  // =========================================================================

  function findButton(selector) {
    return document.querySelector(selector);
  }

  function isButtonActive(button) {
    var frame = button.closest(FRAME_SELECTOR);
    return frame ? frame.classList.contains(ACTIVE_CLASS) : false;
  }

  // =========================================================================
  // Keydown handler
  // =========================================================================

  function handleKeyDown(event) {
    // Skip when typing in form controls
    var tag = event.target.tagName.toLowerCase();
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      event.target.isContentEditable
    ) {
      return;
    }

    // Skip when ctrl/alt/meta are held (allow shift through)
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    var pressed = event.key.toLowerCase();
    var now = Date.now();

    // --- v-prefix sequences (vt, ve, vg, vx, vy, vz, va, vo) ---
    if (vPrefixActive) {
      vPrefixActive = false;
      hideWhichKey();

      if ((now - vPrefixTime) >= NUM_PREFIX_TIMEOUT_MS) {
        // Timed out, fall through
      } else {
        var vBinding = V_PREFIX_MAP[pressed];
        if (vBinding) {
          if (vBinding.checkbox) {
            // Grid plane checkbox — toggle it
            var cb = document.querySelector(vBinding.checkbox);
            if (cb) {
              cb.click();
              showToast(vBinding.label + (cb.checked ? " ON" : " OFF"), cb.checked);
            } else {
              showToast(vBinding.label + " — not found", false);
            }
          } else {
            var btn = findButton(vBinding.selector);
            if (btn) {
              btn.click();
              var active = isButtonActive(btn);
              showToast(vBinding.label + (active ? " ON" : " OFF"), active);
            } else {
              showToast(vBinding.label + " — not found", false);
            }
          }
          return;
        }
        showToast("Unknown view command: v" + pressed, false);
        return;
      }
    }

    // --- Number-prefix sequences (Nv = view, Nh = hide, Ny = yank, N{x|y|z}y = yank axis) ---
    if (numPrefix !== "") {
      if ((now - numPrefixTime) >= NUM_PREFIX_TIMEOUT_MS) {
        // Timed out — if axis was 'y', treat as row yank before resetting
        if (numAxis === "y") {
          var num = parseInt(numPrefix, 10);
          numPrefix = "";
          numAxis = "";
          hideWhichKey();
          if (num === 0) {
            yankWholeTable();
          } else {
            yankRowN(num);
          }
          return;
        }
        numPrefix = "";
        numAxis = "";
        hideWhichKey();
      } else {
        // If we already have an axis buffered, only 'y' completes it
        if (numAxis !== "") {
          if (pressed === "y") {
            var num = parseInt(numPrefix, 10);
            var axis = numAxis;
            numPrefix = "";
            numAxis = "";
            hideWhichKey();
            yankRowAxis(num, axis);
            return;
          }
          // Not 'y' — if axis was 'y' (ambiguous Ny), treat as row yank
          // and reprocess current key
          if (numAxis === "y") {
            var num = parseInt(numPrefix, 10);
            numPrefix = "";
            numAxis = "";
            hideWhichKey();
            if (num === 0) {
              yankWholeTable();
            } else {
              yankRowN(num);
            }
            // Don't return — let the current key fall through to be processed
          } else {
            // Invalid axis sequence (e.g. 2xh), reset
            numPrefix = "";
            numAxis = "";
            hideWhichKey();
            showToast("Invalid yank sequence", false);
            return;
          }
        }

        if (pressed === "v") {
          // Camera view: Nv
          var num = numPrefix;
          numPrefix = "";
          hideWhichKey();
          var view = VIEW_MAP[num];
          if (view) {
            var btn = findButton(view.selector);
            if (btn) {
              btn.click();
              showToast(view.label, true);
            } else {
              showToast(view.label + " — not found", false);
            }
          } else {
            showToast("No view for " + num, false);
          }
          return;
        }
        if (pressed === "h") {
          // Hide/show tree node: Nh
          var num = parseInt(numPrefix, 10);
          numPrefix = "";
          hideWhichKey();
          handleHideByNumber(num);
          return;
        }
        // Axis letter (x, y, z) — buffer it, wait for 'y' to confirm
        if (pressed === "x" || pressed === "y" || pressed === "z") {
          numAxis = pressed;
          numPrefixTime = now;
          showWhichKey("numaxis");
          return;
        }
        // Additional digit — append (for nodes > 9)
        if (pressed >= "0" && pressed <= "9") {
          numPrefix += pressed;
          numPrefixTime = now;
          showWhichKey("numprefix");
          return;
        }
        // Invalid follow-up, reset
        numPrefix = "";
        hideWhichKey();
        // Fall through to process this key normally
      }
    }

    // --- Yank: yy = yank primary (first row) ---
    if (yankSequence.length > 0) {
      if ((now - lastKeyTime) >= YANK_SEQUENCE_TIMEOUT_MS) {
        yankSequence = [];
        hideWhichKey();
      } else {
        if (pressed === "y") {
          yankSequence = [];
          hideWhichKey();
          yankPrimary();
          return;
        }
        // Invalid after 'y' (not another 'y'), reset
        yankSequence = [];
        hideWhichKey();
        // Fall through to process this key normally
      }
    }

    // Start yank sequence with 'y' (only when no number prefix active)
    if (pressed === "y" && !event.shiftKey) {
      yankSequence = ["y"];
      lastKeyTime = now;
      showWhichKey();
      return;
    }

    // Start v-prefix sequence
    if (pressed === "v" && !event.shiftKey) {
      vPrefixActive = true;
      vPrefixTime = now;
      showWhichKey("view");
      return;
    }

    // Start number-prefix sequence
    if (pressed >= "0" && pressed <= "9" && !event.shiftKey) {
      numPrefix = pressed;
      numPrefixTime = now;
      showWhichKey("numprefix");
      return;
    }

    // --- Unit conversion shortcuts ---
    if (pressed === "i" && !event.shiftKey) {
      switchUnit(currentUnit === "mm" ? "inch" : "mm");
      showToast("Units: " + (currentUnit === "mm" ? "mm" : "inches"), true);
      return;
    }

    if (pressed === "i" && event.shiftKey) {
      if (currentUnit === "inch") {
        var idx = PRECISIONS.indexOf(currentPrecision);
        currentPrecision = PRECISIONS[(idx + 1) % PRECISIONS.length];
        updateToolbar();
        convertAllCells();
        showToast('Precision: 1/' + currentPrecision + '"', true);
      } else {
        showToast("Switch to inches first (press I)", false);
      }
      return;
    }

    // --- Toolbar button shortcuts ---
    var mapKey = (event.shiftKey ? "shift+" : "") + pressed;
    var binding = KEY_MAP[mapKey];
    if (!binding) return;

    var button = findButton(binding.selector);
    if (!button) {
      showToast(binding.label + " — toolbar not ready", false);
      return;
    }

    button.click();

    var wasToggled = isButtonActive(button);
    showToast(binding.label + (wasToggled ? " ON" : " OFF"), wasToggled);
  }

  // =========================================================================
  // Initialization — wait for toolbar then attach listener
  // =========================================================================

  function init() {
    var attempts = 0;
    var firstSelector = KEYBINDINGS[0] ? KEYBINDINGS[0].selector : null;

    function poll() {
      attempts++;
      if (firstSelector && document.querySelector(firstSelector)) {
        attach();
        return;
      }
      if (attempts >= MAX_POLL_ATTEMPTS) {
        attach();
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    }

    function attach() {
      document.addEventListener("keydown", handleKeyDown);
      createToolbar();
      startCopyBtnPoll();
      console.log(
        "[OCP Keybindings] Ready. Keys: " +
          KEYBINDINGS.map(function (b) {
            return (b.shift ? "Shift+" : "") + b.key.toUpperCase() + "=" + b.label;
          }).join(", ") +
          ", Nv=View, Nh=Hide/Show, v+=View options, y+=Yank, I=mm/inch"
      );
    }

    poll();
  }

  init();
})();
