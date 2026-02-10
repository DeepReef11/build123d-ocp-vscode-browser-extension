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

    // Camera views (number keys → toolbar order)
    { key: "0", shift: false, selector: "input.tcv_button_iso",    label: "Iso View" },
    { key: "1", shift: false, selector: "input.tcv_button_front",  label: "Front View" },
    { key: "2", shift: false, selector: "input.tcv_button_rear",   label: "Back View" },
    { key: "3", shift: false, selector: "input.tcv_button_top",    label: "Top View" },
    { key: "4", shift: false, selector: "input.tcv_button_bottom", label: "Bottom View" },
    { key: "5", shift: false, selector: "input.tcv_button_left",   label: "Left View" },
    { key: "6", shift: false, selector: "input.tcv_button_right",  label: "Right View" },

    // --- Add more bindings here ---
  ];

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

      cell.textContent = newText;
      cellTextCache.set(cell, newText);
    }
  }

  function restoreAllCells() {
    var cells = document.querySelectorAll(MEASURE_VAL_SELECTOR);
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (cellMmCache.has(cell)) {
        var mmText = cellMmCache.get(cell).toFixed(3);
        cell.textContent = mmText;
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

  function createCopyButton(row, isCoords) {
    var btn = document.createElement("button");
    btn.className = "ocp-copy-coords-btn";
    btn.textContent = "📋";
    btn.title = isCoords ? "Copy coordinates" : "Copy value";
    Object.assign(btn.style, {
      marginLeft: "6px",
      padding: "2px 5px",
      border: "1px solid #666",
      borderRadius: "3px",
      background: "#333",
      color: "#fff",
      cursor: "pointer",
      fontSize: "10px",
      lineHeight: "1",
      verticalAlign: "middle",
    });

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var th = row.querySelector("th.tcv_measure_key");
      var label = th ? th.textContent.replace(/📋/g, "").trim() : "value";

      if (isCoords) {
        copyCoords(row, label);
      } else {
        copySingleValue(row, label);
      }
    });

    return btn;
  }

  // Create a small copy button for individual cell values
  function createCellCopyButton(cell, axis) {
    var btn = document.createElement("button");
    btn.className = "ocp-copy-cell-btn";
    btn.textContent = "📋";
    btn.title = "Copy " + axis + " value";
    Object.assign(btn.style, {
      marginLeft: "4px",
      padding: "1px 3px",
      border: "1px solid #555",
      borderRadius: "2px",
      background: "#2a2a2a",
      color: "#fff",
      cursor: "pointer",
      fontSize: "8px",
      lineHeight: "1",
      verticalAlign: "middle",
      opacity: "0.7",
    });

    btn.addEventListener("mouseenter", function () {
      btn.style.opacity = "1";
    });
    btn.addEventListener("mouseleave", function () {
      btn.style.opacity = "0.7";
    });

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var val = getCellValue(cell);
      var text = val.toFixed(3);

      navigator.clipboard.writeText(text).then(function () {
        showToast("Copied " + axis + ": " + text, true);
      }).catch(function () {
        showToast("Copy failed", false);
      });
    });

    return btn;
  }

  // Check if row is a Reference row (should not get copy button)
  function isReferenceRow(row) {
    var th = row.querySelector("th.tcv_measure_key");
    if (!th) return false;
    var label = th.textContent.trim().toLowerCase();
    return label.startsWith("reference");
  }

  function addCopyButtonsToPanel() {
    // Process both properties and distance panels
    var panels = document.querySelectorAll(PROPERTIES_PANEL_SELECTOR + ", " + DISTANCE_PANEL_SELECTOR);

    for (var i = 0; i < panels.length; i++) {
      var panel = panels[i];
      var rows = panel.querySelectorAll("tr");

      for (var j = 0; j < rows.length; j++) {
        var row = rows[j];
        var th = row.querySelector("th.tcv_measure_key");
        if (!th) continue;
        if (isReferenceRow(row)) continue; // Skip reference rows

        // Check for x/y/z coordinates
        var xCell = row.querySelector(".tcv_x_measure_val");
        var yCell = row.querySelector(".tcv_y_measure_val");
        var zCell = row.querySelector(".tcv_z_measure_val");
        var hasCoords = xCell && yCell && zCell;

        if (hasCoords) {
          // Add main copy button to header (if not already present)
          if (!th.querySelector(".ocp-copy-coords-btn")) {
            th.appendChild(createCopyButton(row, true));
          }

          // Add individual cell copy buttons
          if (!xCell.querySelector(".ocp-copy-cell-btn")) {
            xCell.appendChild(createCellCopyButton(xCell, "X"));
          }
          if (!yCell.querySelector(".ocp-copy-cell-btn")) {
            yCell.appendChild(createCellCopyButton(yCell, "Y"));
          }
          if (!zCell.querySelector(".ocp-copy-cell-btn")) {
            zCell.appendChild(createCellCopyButton(zCell, "Z"));
          }
          continue;
        }

        // Check for single value (Area, Angle, distance, angle)
        if (!th.querySelector(".ocp-copy-coords-btn")) {
          var valueCells = row.querySelectorAll(".tcv_measure_val");
          var hasSingleValue = false;
          for (var k = 0; k < valueCells.length; k++) {
            var cell = valueCells[k];
            if (!cell.classList.contains("tcv_x_measure_val") &&
                !cell.classList.contains("tcv_y_measure_val") &&
                !cell.classList.contains("tcv_z_measure_val")) {
              hasSingleValue = true;
              break;
            }
          }

          if (hasSingleValue) {
            th.appendChild(createCopyButton(row, false));
          }
        }
      }
    }
  }

  function startCopyBtnPoll() {
    if (copyBtnPollTimer) return;
    copyBtnPollTimer = setInterval(addCopyButtonsToPanel, COPY_BTN_POLL_MS);
  }

  // =========================================================================
  // Yank Keybindings - Extended system with which-key support
  // =========================================================================

  // Find row by label text in a panel (case-insensitive partial match)
  function findRowByLabel(panel, labelMatch) {
    var rows = panel.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      var th = rows[i].querySelector("th.tcv_measure_key");
      if (th && th.textContent.toLowerCase().indexOf(labelMatch.toLowerCase()) !== -1) {
        return rows[i];
      }
    }
    return null;
  }

  // Get the primary row for current panel (Center/XYZ for properties, distance for distance panel)
  function getPrimaryRow() {
    var distPanel = document.querySelector(DISTANCE_PANEL_SELECTOR);
    var propPanel = document.querySelector(PROPERTIES_PANEL_SELECTOR);

    if (distPanel && distPanel.style.display !== "none") {
      return { panel: distPanel, row: findRowByLabel(distPanel, "distance"), label: "distance", isCoords: false };
    }
    if (propPanel && propPanel.style.display !== "none") {
      // Check for XYZ (vertex) first, then Center (face)
      var xyzRow = findRowByLabel(propPanel, "xyz");
      if (xyzRow) return { panel: propPanel, row: xyzRow, label: "XYZ", isCoords: true };
      var centerRow = findRowByLabel(propPanel, "center");
      if (centerRow) return { panel: propPanel, row: centerRow, label: "Center", isCoords: true };
    }
    return null;
  }

  // Copy single axis from a row
  function copySingleAxis(row, axis, label) {
    var cellClass = ".tcv_" + axis.toLowerCase() + "_measure_val";
    var cell = row.querySelector(cellClass);
    if (!cell) {
      showToast(axis + " not found", false);
      return false;
    }
    var val = getCellValue(cell);
    var text = val.toFixed(3);
    navigator.clipboard.writeText(text).then(function () {
      showToast("Copied " + label + " " + axis + ": " + text, true);
    }).catch(function () {
      showToast("Copy failed", false);
    });
    return true;
  }

  // Yank command handlers for different sequences
  var yankHandlers = {
    // Primary value: yy = full coords or distance
    "y": function () {
      var primary = getPrimaryRow();
      if (!primary || !primary.row) {
        showToast("No panel visible", false);
        return false;
      }
      if (primary.isCoords) {
        copyCoords(primary.row, primary.label);
      } else {
        copySingleValue(primary.row, primary.label);
      }
      return true;
    },

    // Individual axes of primary: yx, yc (y-center), yz
    "x": function () {
      var primary = getPrimaryRow();
      if (!primary || !primary.row || !primary.isCoords) {
        showToast("No coordinates available", false);
        return false;
      }
      return copySingleAxis(primary.row, "X", primary.label);
    },
    "c": function () {  // 'c' for center/Y axis
      var primary = getPrimaryRow();
      if (!primary || !primary.row || !primary.isCoords) {
        showToast("No coordinates available", false);
        return false;
      }
      return copySingleAxis(primary.row, "Y", primary.label);
    },
    "z": function () {
      var primary = getPrimaryRow();
      if (!primary || !primary.row || !primary.isCoords) {
        showToast("No coordinates available", false);
        return false;
      }
      return copySingleAxis(primary.row, "Z", primary.label);
    },

    // Area and Angle
    "a": function () {
      var propPanel = document.querySelector(PROPERTIES_PANEL_SELECTOR);
      if (!propPanel || propPanel.style.display === "none") {
        showToast("Properties panel not visible", false);
        return false;
      }
      var row = findRowByLabel(propPanel, "area");
      if (row) {
        copySingleValue(row, "Area");
        return true;
      }
      showToast("Area not found", false);
      return false;
    },
    "g": function () {  // 'g' for angle (a is taken)
      var propPanel = document.querySelector(PROPERTIES_PANEL_SELECTOR);
      if (!propPanel || propPanel.style.display === "none") {
        showToast("Properties panel not visible", false);
        return false;
      }
      var row = findRowByLabel(propPanel, "angle");
      if (row) {
        copySingleValue(row, "Angle");
        return true;
      }
      showToast("Angle not found", false);
      return false;
    },

    // Distance panel points
    "1": function () {
      var distPanel = document.querySelector(DISTANCE_PANEL_SELECTOR);
      if (!distPanel || distPanel.style.display === "none") {
        showToast("Distance panel not visible", false);
        return false;
      }
      var row = findRowByLabel(distPanel, "point 1");
      if (row) {
        copyCoords(row, "Point 1");
        return true;
      }
      showToast("Point 1 not found", false);
      return false;
    },
    "2": function () {
      var distPanel = document.querySelector(DISTANCE_PANEL_SELECTOR);
      if (!distPanel || distPanel.style.display === "none") {
        showToast("Distance panel not visible", false);
        return false;
      }
      var row = findRowByLabel(distPanel, "point 2");
      if (row) {
        copyCoords(row, "Point 2");
        return true;
      }
      showToast("Point 2 not found", false);
      return false;
    },

    // Delta vector (⇒ X | Y | Z)
    "d": function () {
      var distPanel = document.querySelector(DISTANCE_PANEL_SELECTOR);
      if (!distPanel || distPanel.style.display === "none") {
        showToast("Distance panel not visible", false);
        return false;
      }
      var row = findRowByLabel(distPanel, "⇒");
      if (row) {
        copyCoords(row, "Delta");
        return true;
      }
      showToast("Delta not found", false);
      return false;
    },

    // Distance angle
    "n": function () {  // 'n' for angle in distance panel
      var distPanel = document.querySelector(DISTANCE_PANEL_SELECTOR);
      if (!distPanel || distPanel.style.display === "none") {
        showToast("Distance panel not visible", false);
        return false;
      }
      var row = findRowByLabel(distPanel, "angle");
      if (row) {
        copySingleValue(row, "Angle");
        return true;
      }
      showToast("Angle not found", false);
      return false;
    }
  };

  // Bounding box sub-handlers (after 'yb')
  var bbHandlers = {
    "m": function () {  // min
      var propPanel = document.querySelector(PROPERTIES_PANEL_SELECTOR);
      if (!propPanel || propPanel.style.display === "none") {
        showToast("Properties panel not visible", false);
        return false;
      }
      var row = findRowByLabel(propPanel, "bb min");
      if (row) {
        copyCoords(row, "BB min");
        return true;
      }
      showToast("BB min not found", false);
      return false;
    },
    "c": function () {  // center
      var propPanel = document.querySelector(PROPERTIES_PANEL_SELECTOR);
      if (!propPanel || propPanel.style.display === "none") {
        showToast("Properties panel not visible", false);
        return false;
      }
      var row = findRowByLabel(propPanel, "bb center");
      if (row) {
        copyCoords(row, "BB center");
        return true;
      }
      showToast("BB center not found", false);
      return false;
    },
    "x": function () {  // max
      var propPanel = document.querySelector(PROPERTIES_PANEL_SELECTOR);
      if (!propPanel || propPanel.style.display === "none") {
        showToast("Properties panel not visible", false);
        return false;
      }
      var row = findRowByLabel(propPanel, "bb max");
      if (row) {
        copyCoords(row, "BB max");
        return true;
      }
      showToast("BB max not found", false);
      return false;
    },
    "s": function () {  // size
      var propPanel = document.querySelector(PROPERTIES_PANEL_SELECTOR);
      if (!propPanel || propPanel.style.display === "none") {
        showToast("Properties panel not visible", false);
        return false;
      }
      var row = findRowByLabel(propPanel, "bb size");
      if (row) {
        copyCoords(row, "BB size");
        return true;
      }
      showToast("BB size not found", false);
      return false;
    }
  };

  // Process yank sequence and execute if complete
  function processYankSequence(seq) {
    if (seq.length === 0) return false;

    // Check for 'b' prefix (bounding box submenu)
    if (seq[0] === "b") {
      if (seq.length === 1) {
        // Show BB submenu
        return "bb";  // signal to show BB which-key
      }
      if (seq.length === 2 && bbHandlers[seq[1]]) {
        bbHandlers[seq[1]]();
        return true;
      }
      return false;  // invalid
    }

    // Single key handlers
    if (seq.length === 1 && yankHandlers[seq[0]]) {
      yankHandlers[seq[0]]();
      return true;
    }

    return false;  // not a valid sequence
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

    if (mode === "bb") {
      // Bounding box submenu
      html = '<div style="color: #888; margin-bottom: 6px; font-size: 11px;">Yank BB:</div>';
      html += '<div style="display: flex; gap: 16px;">';
      html += '<div>';
      html += renderWhichKeyOption("m", "min", !propVisible);
      html += renderWhichKeyOption("c", "center", !propVisible);
      html += '</div><div>';
      html += renderWhichKeyOption("x", "max", !propVisible);
      html += renderWhichKeyOption("s", "size", !propVisible);
      html += '</div></div>';
    } else {
      // Main yank menu
      var primary = getPrimaryRow();
      var primaryLabel = primary ? primary.label : (distVisible ? "distance" : "Center/XYZ");
      var hasCoords = primary && primary.isCoords;

      html = '<div style="color: #888; margin-bottom: 6px; font-size: 11px;">Yank:</div>';
      html += '<div style="display: flex; gap: 16px;">';

      // Left column - primary and axes
      html += '<div>';
      html += renderWhichKeyOption("y", primaryLabel, !primary);
      if (hasCoords) {
        html += renderWhichKeyOption("x", "X", false);
        html += renderWhichKeyOption("c", "Y", false);
        html += renderWhichKeyOption("z", "Z", false);
      }
      html += '</div>';

      // Middle column - properties specific
      html += '<div>';
      if (panelType === "face") {
        html += renderWhichKeyOption("a", "Area", false);
        html += renderWhichKeyOption("g", "Angle", false);
        html += renderWhichKeyOption("b", "BB →", false);
      } else if (panelType === "vertex") {
        html += renderWhichKeyOption("b", "BB →", true);
      } else if (distVisible) {
        html += renderWhichKeyOption("d", "Delta", false);
        html += renderWhichKeyOption("n", "Angle", false);
      }
      html += '</div>';

      // Right column - distance points
      html += '<div>';
      if (distVisible) {
        html += renderWhichKeyOption("1", "Point 1", false);
        html += renderWhichKeyOption("2", "Point 2", false);
      }
      html += '</div>';

      html += '</div>';
    }

    panel.innerHTML = html;
    panel.style.opacity = "1";

    // Auto-hide after timeout
    if (whichKeyTimer) clearTimeout(whichKeyTimer);
    whichKeyTimer = setTimeout(function () {
      hideWhichKey();
      yankSequence = [];
      lastKeyTime = 0;
    }, YANK_SEQUENCE_TIMEOUT_MS);
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

    // --- Yank keybind sequences ---
    // Check if we're in a yank sequence (started with 'y')
    if (yankSequence.length > 0) {
      // Check timeout
      if ((now - lastKeyTime) >= YANK_SEQUENCE_TIMEOUT_MS) {
        // Sequence timed out, reset
        yankSequence = [];
        hideWhichKey();
      } else {
        // Add key to sequence and try to process
        yankSequence.push(pressed);
        lastKeyTime = now;

        // Process sequence (skip the initial 'y' marker)
        var seqAfterY = yankSequence.slice(1);
        var result = processYankSequence(seqAfterY);
        if (result === true) {
          // Sequence completed successfully
          yankSequence = [];
          hideWhichKey();
          return;
        } else if (result === "bb") {
          // Show BB submenu
          showWhichKey("bb");
          return;
        } else if (result === false && seqAfterY.length >= 2) {
          // Invalid sequence, reset
          yankSequence = [];
          hideWhichKey();
          showToast("Invalid yank sequence", false);
          return;
        }
        // Sequence still building, keep waiting
        return;
      }
    }

    // Start yank sequence with 'y'
    if (pressed === "y") {
      yankSequence = ["y"];  // Mark that we're in yank mode, waiting for next key
      lastKeyTime = now;
      showWhichKey();
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

    // Toggle buttons show ON/OFF; one-shot buttons (views) just show the label
    var frame = button.closest(FRAME_SELECTOR);
    var isToggle = frame && frame.classList.contains(ACTIVE_CLASS) !== undefined;
    var wasToggled = isButtonActive(button);

    // View buttons don't have a persistent active state — just confirm the action
    if (binding.selector.match(/_(iso|front|rear|top|bottom|left|right)$/)) {
      showToast(binding.label, true);
    } else {
      showToast(binding.label + (wasToggled ? " ON" : " OFF"), wasToggled);
    }
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
        "[OCP Keybindings] Ready. Registered keys: " +
          KEYBINDINGS.map(function (b) {
            return b.key.toUpperCase() + "=" + b.label;
          }).join(", ") +
          ", I=Toggle mm/inch, Shift+I=Cycle precision"
      );
    }

    poll();
  }

  init();
})();
