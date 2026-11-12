/** Reader-only controls. Sidebar size is local to this device. */
(function () {
  const sidebar = document.getElementById("paperSidebar");
  const handle = document.getElementById("sidebarResizeHandle");
  const key = "fsi_reader_sidebar_width";
  const limit = width => Math.round(Math.max(180, Math.min(width, Math.min(650, Math.max(180, innerWidth - 360)))));
  function resize(width, persist) {
    if (!Number.isFinite(width)) return;
    const actual = limit(width);
    sidebar.style.setProperty("--reader-sidebar-width", actual + "px");
    handle.setAttribute("aria-valuenow", actual);
    if (persist) { try { localStorage.setItem(key, actual); } catch (_) {} }
  }
  let saved;
  try { saved = Number(localStorage.getItem(key)); } catch (_) {}
  resize(saved >= 180 ? saved : 290, false);
  let drag = null;
  handle.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, width: sidebar.getBoundingClientRect().width };
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-sidebar");
    e.preventDefault();
  });
  handle.addEventListener("pointermove", e => {
    if (drag) resize(drag.width + e.clientX - drag.x, false);
  });
  function stop() {
    if (!drag) return;
    drag = null;
    document.body.classList.remove("resizing-sidebar");
    resize(sidebar.getBoundingClientRect().width, true);
    if (window.PdfViewer) PdfViewer.handleResize();
  }
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("lostpointercapture", stop);
  handle.addEventListener("dblclick", () => resize(290, true));
  handle.addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    resize(sidebar.getBoundingClientRect().width + (e.key === "ArrowLeft" ? -10 : 10), true);
  });
  window.addEventListener("resize", () => {
    if (innerWidth > 768) resize(parseFloat(sidebar.style.getPropertyValue("--reader-sidebar-width")) || 290, false);
  });
  function resetZoom(input) { input.value = Math.round(PdfViewer.getScale() * 100); }
  function commitZoom(input) {
    const text = input.value.trim().replace(/%$/, "").trim();
    const value = Number(text);
    if (!text || !Number.isFinite(value) || value <= 0) { resetZoom(input); return; }
    const scale = Math.max(50, Math.min(400, value)) / 100;
    if (scale !== PdfViewer.getScale()) PdfViewer.setScale(scale);
    resetZoom(input);
  }
  document.addEventListener("change", e => { if (e.target.id === "pdfZoomLabel") commitZoom(e.target); });
  document.addEventListener("keydown", e => {
    if (e.target.id !== "pdfZoomLabel") return;
    if (e.key === "Enter") { e.preventDefault(); commitZoom(e.target); e.target.blur(); }
    if (e.key === "Escape") { resetZoom(e.target); e.target.blur(); }
  });
  document.addEventListener("focusin", e => { if (e.target.id === "pdfZoomLabel") e.target.select(); });
})();
