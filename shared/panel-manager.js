/**
 * PanelManager — Flexible multi-panel layout engine.
 * Panels can be resized, minimized, and reordered via drag-and-drop.
 * State persisted to localStorage.
 * Exposes global window.PanelManager.
 */
(function() {
  const STORAGE_KEY = "fsi_panel_state";
  const MIN_PANEL_W = 180;   // absolute minimum width px
  const HANDLE_W = 5;        // resize handle width
  const MINIMIZED_W = 40;    // collapsed panel width

  let _container = null;
  let _panels = {};           // { id: config }
  let _order = [];            // [id, id, ...]
  let _widths = {};           // { id: fraction(0-1) }  relative to total
  let _minimized = new Set();
  let _onPanelResize = null;
  let _layoutBuilt = false;

  // ── Init ────────────────────────────────────────────
  function init(containerEl, opts) {
    _container = containerEl;
    _onPanelResize = (opts && opts.onPanelResize) || null;
    _panels = {};
    _order = [];
    _widths = {};
    _minimized = new Set();
    _layoutBuilt = false;
  }

  // ── Register ────────────────────────────────────────
  function registerPanel(cfg) {
    // cfg: { id, title, icon, render(contentEl), onResize?, onShow?, onHide?, minWidth?, defaultFlex? }
    _panels[cfg.id] = cfg;
    if (!_order.includes(cfg.id)) _order.push(cfg.id);
    if (!_widths[cfg.id]) _widths[cfg.id] = cfg.defaultFlex || 1;
  }

  // ── State persistence ──────────────────────────────
  function _saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        order: _order, widths: _widths, minimized: [..._minimized]
      }));
    } catch(e) {}
  }

  function restoreState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.order && Array.isArray(s.order)) {
        const valid = s.order.filter(id => _panels[id]);
        Object.keys(_panels).forEach(id => { if (!valid.includes(id)) valid.push(id); });
        _order = valid;
      }
      if (s.widths) {
        Object.keys(s.widths).forEach(id => { if (_panels[id]) _widths[id] = s.widths[id]; });
      }
      if (s.minimized && Array.isArray(s.minimized)) {
        s.minimized.forEach(id => { if (_panels[id]) _minimized.add(id); });
      }
    } catch(e) {}
  }

  // ── Shared panel DOM builder ─────────────────────────
  // Creates panel + header + content + resize handle for one panel.
  // If contentFragment is provided, it is appended to the content div (used by _rebuildLayoutDOM to preserve existing content).
  // Returns the content element for external use.
  function _buildPanel(id, idx, contentFragment) {
    const cfg = _panels[id];
    if (!cfg) return null;
    const isMin = _minimized.has(id);

    // Panel wrapper
    const panel = document.createElement("div");
    panel.className = "panel" + (isMin ? " minimized" : "");
    panel.dataset.panelId = id;
    panel.style.flex = isMin ? ("0 0 " + MINIMIZED_W + "px") : (_widths[id] || 1);

    // Header
    const header = document.createElement("div");
    header.className = "panel-header";
    header.draggable = true;
    header.innerHTML =
      '<span class="panel-icon">' + (cfg.icon || "📋") + '</span>' +
      '<span class="panel-title">' + (cfg.title || id) + '</span>' +
      '<span class="panel-actions">' +
        '<button class="panel-btn panel-minimize-btn" title="' + (isMin ? "展开" : "最小化") + '">' + (isMin ? "□" : "─") + '</button>' +
      '</span>';

    // Drag-to-reorder
    header.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
      panel.classList.add("dragging");
    });
    header.addEventListener("dragend", () => panel.classList.remove("dragging"));
    panel.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; panel.classList.add("drag-over"); });
    panel.addEventListener("dragleave", () => panel.classList.remove("drag-over"));
    panel.addEventListener("drop", e => {
      e.preventDefault();
      panel.classList.remove("drag-over");
      const fromId = e.dataTransfer.getData("text/plain");
      if (fromId && fromId !== id) _swapPanels(fromId, id);
    });

    // Minimize button
    header.querySelector(".panel-minimize-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel(id);
    });

    // Content area
    const content = document.createElement("div");
    content.className = "panel-content";
    content.id = "panel-content-" + id;
    if (contentFragment) content.appendChild(contentFragment);

    panel.appendChild(header);
    panel.appendChild(content);
    _container.appendChild(panel);

    // Resize handle (between panels, not after last)
    if (idx < _order.length - 1) {
      const handle = document.createElement("div");
      handle.className = "panel-resize-handle";
      handle.dataset.left = id;
      handle.dataset.right = _order[idx + 1];
      _setupResizeHandle(handle);
      _container.appendChild(handle);
    }

    return content;
  }

  // ── Render layout ──────────────────────────────────
  function renderLayout() {
    if (!_container) return;
    _container.innerHTML = "";
    _container.className = "panel-layout";

    _order.forEach((id, idx) => { _buildPanel(id, idx, null); });

    // Render each panel's content
    _order.forEach(id => {
      const cfg = _panels[id];
      if (!cfg) return;
      const contentEl = document.getElementById("panel-content-" + id);
      if (contentEl && cfg.render) cfg.render(contentEl);
    });

    _layoutBuilt = true;
  }

  // ── Swap panels (reorder) ──────────────────────────
  function _swapPanels(fromId, toId) {
    const fi = _order.indexOf(fromId);
    const ti = _order.indexOf(toId);
    if (fi < 0 || ti < 0) return;

    // Move DOM nodes instead of rebuilding
    const fromPanel = _container.querySelector('[data-panel-id="' + fromId + '"]');
    const toPanel = _container.querySelector('[data-panel-id="' + toId + '"]');
    if (!fromPanel || !toPanel) { _order.splice(fi, 1); _order.splice(ti, 0, fromId); _saveState(); renderLayout(); return; }

    // Swap in order array
    _order[fi] = toId;
    _order[ti] = fromId;
    _saveState();

    // Rebuild layout preserving content nodes
    _rebuildLayoutDOM();
  }

  function _rebuildLayoutDOM() {
    // Detach all panel content children to preserve them
    const contents = {};
    _order.forEach(id => {
      const el = document.getElementById("panel-content-" + id);
      if (el) {
        const frag = document.createDocumentFragment();
        while (el.firstChild) frag.appendChild(el.firstChild);
        contents[id] = frag;
      }
    });

    // Rebuild structure reusing shared builder
    _container.innerHTML = "";
    _order.forEach((id, idx) => { _buildPanel(id, idx, contents[id] || null); });
  }

  // ── Resize handle logic ────────────────────────────
  function _setupResizeHandle(handle) {
    let startX, leftW0, rightW0, leftPanel, rightPanel, totalW;

    handle.addEventListener("mousedown", e => {
      e.preventDefault();
      const leftId = handle.dataset.left, rightId = handle.dataset.right;
      leftPanel = _container.querySelector('[data-panel-id="' + leftId + '"]');
      rightPanel = _container.querySelector('[data-panel-id="' + rightId + '"]');
      if (!leftPanel || !rightPanel) return;
      if (_minimized.has(leftId) || _minimized.has(rightId)) return;

      startX = e.clientX;
      leftW0 = leftPanel.offsetWidth;
      rightW0 = rightPanel.offsetWidth;
      totalW = leftW0 + rightW0;
      handle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = ev => {
        const dx = ev.clientX - startX;
        let newLeft = Math.max(MIN_PANEL_W, leftW0 + dx);
        let newRight = totalW - newLeft;
        if (newRight < MIN_PANEL_W) { newRight = MIN_PANEL_W; newLeft = totalW - newRight; }
        leftPanel.style.flex = "0 0 " + newLeft + "px";
        rightPanel.style.flex = "0 0 " + newRight + "px";
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        handle.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        // Convert back to flex ratios
        const leftId = handle.dataset.left, rightId = handle.dataset.right;
        const lw = leftPanel.offsetWidth, rw = rightPanel.offsetWidth;
        const ratio = lw / (lw + rw);
        const oldTotal = (_widths[leftId] || 1) + (_widths[rightId] || 1);
        _widths[leftId] = oldTotal * ratio;
        _widths[rightId] = oldTotal * (1 - ratio);
        leftPanel.style.flex = _widths[leftId];
        rightPanel.style.flex = _widths[rightId];
        _saveState();

        // Notify panels they resized
        _notifyResize(leftId);
        _notifyResize(rightId);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  let _resizeTimers = {};
  function _notifyResize(panelId) {
    clearTimeout(_resizeTimers[panelId]);
    _resizeTimers[panelId] = setTimeout(() => {
      const cfg = _panels[panelId];
      if (cfg && cfg.onResize) cfg.onResize();
      if (_onPanelResize) _onPanelResize(panelId);
    }, 200);
  }

  // ── Minimize / Show ────────────────────────────────
  function togglePanel(id) {
    if (_minimized.has(id)) showPanel(id); else hidePanel(id);
  }

  function showPanel(id) {
    _minimized.delete(id);
    _saveState();
    const panel = _container.querySelector('[data-panel-id="' + id + '"]');
    if (panel) {
      panel.classList.remove("minimized");
      panel.style.flex = _widths[id] || 1;
      const btn = panel.querySelector(".panel-minimize-btn");
      if (btn) { btn.textContent = "─"; btn.title = "最小化"; }
    }
    const cfg = _panels[id];
    if (cfg && cfg.onShow) cfg.onShow();
    _order.forEach(pid => { if (pid !== id && !_minimized.has(pid)) _notifyResize(pid); });
    _notifyResize(id);
  }

  function hidePanel(id) {
    _minimized.add(id);
    _saveState();
    const panel = _container.querySelector('[data-panel-id="' + id + '"]');
    if (panel) {
      panel.classList.add("minimized");
      panel.style.flex = "0 0 " + MINIMIZED_W + "px";
      const btn = panel.querySelector(".panel-minimize-btn");
      if (btn) { btn.textContent = "□"; btn.title = "展开"; }
    }
    const cfg = _panels[id];
    if (cfg && cfg.onHide) cfg.onHide();
    _order.forEach(pid => { if (pid !== id && !_minimized.has(pid)) _notifyResize(pid); });
  }

  function getPanelContainer(id) {
    return document.getElementById("panel-content-" + id);
  }

  function isPanelVisible(id) {
    return !_minimized.has(id);
  }

  // ── Window resize handler ──────────────────────────
  let _winResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(_winResizeTimer);
    _winResizeTimer = setTimeout(() => {
      _order.forEach(id => { if (!_minimized.has(id)) _notifyResize(id); });
    }, 300);
  });

  // ── Expose API ─────────────────────────────────────
  window.PanelManager = {
    init, registerPanel, renderLayout, restoreState,
    togglePanel, showPanel, hidePanel,
    getPanelContainer, isPanelVisible
  };
})();
