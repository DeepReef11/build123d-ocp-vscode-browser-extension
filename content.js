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

  // =========================================================================
  // Unit Conversion State (session-only, resets on page load)
  // =========================================================================

  var currentUnit = "mm";       // "mm" or "inch"
  var currentPrecision = 16;    // denominator: 8, 16, or 32
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

    var feet = Math.floor(wholeInches / 12);
    var inches = wholeInches % 12;

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

    document.body.appendChild(toolbarEl);
    updateToolbar();
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
