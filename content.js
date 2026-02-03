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
        attach(); // attach anyway so user gets feedback on keypress
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    }

    function attach() {
      document.addEventListener("keydown", handleKeyDown);
      console.log(
        "[OCP Keybindings] Ready. Registered keys: " +
          KEYBINDINGS.map(function (b) {
            return b.key.toUpperCase() + "=" + b.label;
          }).join(", ")
      );
    }

    poll();
  }

  init();
})();
