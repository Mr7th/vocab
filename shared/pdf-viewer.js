/**
 * PdfViewer — PDF rendering engine with text layer, zoom, continuous scroll
 * Uses pdf.js (loaded from CDN). Exposes global window.PdfViewer.
 */
(function() {
  const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
  const MIN_SCALE = 0.5, MAX_SCALE = 4.0, SCALE_STEP = 1.25;
  const LAZY_MARGIN = 800; // pixels above/below viewport to pre-render

  let _doc = null, _scale = 1.2, _container = null, _pagesEl = null;
  let _pageWrappers = []; // [{num, wrapper, canvas, textLayer, rendered}]
  let _highlights = [];   // [{pageNum, rects, color}]
  let _onTextSelect = null, _onPageScroll = null;
  let _scrollTimer = null, _observer = null;
  let _boundScrollFn = null, _boundMouseDownFn = null, _boundMouseUpFn = null, _boundContextMenuFn = null;
  let _initDone = false;

  async function _ensureLib() {
    if (window.pdfjsLib) return;
    await _loadScript(PDFJS_CDN + "/pdf.min.js");
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN + "/pdf.worker.min.js";
  }

  function _loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src;
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }

  function init(containerEl, pagesEl, opts) {
    // Clean up previous listeners if re-initializing
    _removeListeners();
    _container = containerEl;
    _pagesEl = pagesEl;
    _onTextSelect = opts.onTextSelect || null;
    _onPageScroll = opts.onPageScroll || null;
    _setupSelectionListener();
    _setupScrollListener();
    _initDone = true;
  }

  async function loadFromURL(url) {
    await _ensureLib();
    try {
      _doc = await pdfjsLib.getDocument(url).promise;
      _renderAllPlaceholders();
      _setupLazyObserver();
    } catch(e) { console.warn("PDF URL load failed:", e); throw e; }
  }

  async function loadFromBlob(blob) {
    await _ensureLib();
    const buf = await blob.arrayBuffer();
    _doc = await pdfjsLib.getDocument({ data: buf }).promise;
    _renderAllPlaceholders();
    _setupLazyObserver();
  }

  async function loadFromArrayBuffer(buf) {
    await _ensureLib();
    _doc = await pdfjsLib.getDocument({ data: buf }).promise;
    _renderAllPlaceholders();
    _setupLazyObserver();
  }

  function destroy() {
    if (_observer) _observer.disconnect();
    _removeListeners();
    _pageWrappers = []; _highlights = []; _doc = null;
    if (_pagesEl) _pagesEl.innerHTML = "";
    _initDone = false;
  }

  function _removeListeners() {
    if (_boundScrollFn && _container) _container.removeEventListener("scroll", _boundScrollFn);
    if (_boundMouseDownFn) document.removeEventListener("mousedown", _boundMouseDownFn);
    if (_boundMouseUpFn) document.removeEventListener("mouseup", _boundMouseUpFn);
    if (_boundContextMenuFn) document.removeEventListener("contextmenu", _boundContextMenuFn);
    _boundScrollFn = _boundMouseDownFn = _boundMouseUpFn = _boundContextMenuFn = null;
  }

  // Create placeholders for all pages (correct height, lazy render content)
  function _renderAllPlaceholders() {
    if (!_doc || !_pagesEl) return;
    _pagesEl.innerHTML = "";
    _pageWrappers = [];
    for (let i = 1; i <= _doc.numPages; i++) {
      const wrapper = document.createElement("div");
      wrapper.className = "pdf-page-wrapper pdf-page-placeholder";
      wrapper.dataset.page = i;
      // Estimate page size (will correct on render)
      wrapper.style.width = (595 * _scale) + "px";
      wrapper.style.height = (842 * _scale) + "px";
      _pagesEl.appendChild(wrapper);
      _pageWrappers.push({ num: i, wrapper, canvas: null, textLayer: null, rendered: false });
    }
    // Get actual dimensions from first page
    _doc.getPage(1).then(page => {
      const vp = page.getViewport({ scale: _scale });
      _pageWrappers.forEach(pw => {
        if (!pw.rendered) {
          pw.wrapper.style.width = vp.width + "px";
          pw.wrapper.style.height = vp.height + "px";
        }
      });
    });
    _updateToolbarInfo();
  }

  function _setupLazyObserver() {
    if (_observer) _observer.disconnect();
    _observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const num = parseInt(entry.target.dataset.page);
          const pw = _pageWrappers[num - 1];
          if (pw && !pw.rendered) _renderPage(pw);
        }
      });
    }, { root: _container, rootMargin: LAZY_MARGIN + "px 0px" });
    _pageWrappers.forEach(pw => _observer.observe(pw.wrapper));
  }

  async function _renderPage(pw) {
    if (pw.rendered || pw._rendering || !_doc) return;
    pw._rendering = true;
    try {
    const page = await _doc.getPage(pw.num);
    const vp = page.getViewport({ scale: _scale });
    const dpr = window.devicePixelRatio || 1;

    pw.wrapper.classList.remove("pdf-page-placeholder");
    pw.wrapper.style.width = Math.floor(vp.width) + "px";
    pw.wrapper.style.height = Math.floor(vp.height) + "px";
    pw.wrapper.innerHTML = "";

    // Canvas — render at devicePixelRatio for sharp text on HiDPI
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = Math.floor(vp.width) + "px";
    canvas.style.height = Math.floor(vp.height) + "px";
    pw.wrapper.appendChild(canvas);
    pw.canvas = canvas;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    // Text layer — positioned absolutely over canvas, matching viewport exactly
    const textDiv = document.createElement("div");
    textDiv.className = "pdfjs-text-layer";
    pw.wrapper.appendChild(textDiv);
    pw.textLayer = textDiv;

    const textContent = await page.getTextContent();
    const tlTask = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textDiv,
      viewport: vp
    });
    // Wait for text layer to fully render before allowing selection
    if (tlTask && tlTask.promise) await tlTask.promise;
    // CRITICAL: set --scale-factor AFTER renderTextLayer (it overwrites inline styles)
    textDiv.style.setProperty("--scale-factor", _scale);

    // Render any highlights for this page
    _renderHighlightsForPage(pw);
    pw.rendered = true;
    } catch(err) {
      console.warn("PDF page " + pw.num + " render failed:", err);
      // Allow retry on next scroll
    } finally {
      pw._rendering = false;
    }
  }

  async function _reRenderAll() {
    // Save scroll position
    const scrollInfo = getCurrentPage();
    // Clear and re-render
    _pageWrappers.forEach(pw => { pw.rendered = false; });
    _renderAllPlaceholders();
    _setupLazyObserver();
    // Restore scroll position
    if (scrollInfo.pageNum > 0) {
      await new Promise(r => setTimeout(r, 50));
      scrollToPage(scrollInfo.pageNum, scrollInfo.yPosition);
    }
  }

  function setScale(s) {
    _scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    _reRenderAll();
    _updateToolbarInfo();
  }
  function zoomIn() { setScale(_scale * SCALE_STEP); }
  function zoomOut() { setScale(_scale / SCALE_STEP); }
  function zoomFit() {
    if (!_container || !_doc) return;
    const containerW = _container.clientWidth - 32; // padding
    // Use standard A4 width as reference
    _doc.getPage(1).then(page => {
      const vp = page.getViewport({ scale: 1.0 });
      setScale(containerW / vp.width);
    });
  }
  function getScale() { return _scale; }
  function getNumPages() { return _doc ? _doc.numPages : 0; }

  function scrollToPage(pageNum, yFraction) {
    const pw = _pageWrappers[pageNum - 1];
    if (!pw || !_container) return;
    const y = yFraction || 0;
    const top = pw.wrapper.offsetTop + (pw.wrapper.offsetHeight * y) - _container.clientHeight / 3;
    _container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  function getCurrentPage() {
    if (!_container || !_pageWrappers.length) return { pageNum: 1, yPosition: 0 };
    const scrollTop = _container.scrollTop;
    const viewMid = scrollTop + _container.clientHeight / 3;
    for (let i = 0; i < _pageWrappers.length; i++) {
      const pw = _pageWrappers[i];
      const top = pw.wrapper.offsetTop;
      const bot = top + pw.wrapper.offsetHeight;
      if (viewMid >= top && viewMid < bot) {
        return { pageNum: pw.num, yPosition: (viewMid - top) / pw.wrapper.offsetHeight };
      }
    }
    return { pageNum: 1, yPosition: 0 };
  }

  function renderHighlights(highlights) {
    _highlights = highlights || [];
    _pageWrappers.forEach(pw => { if (pw.rendered) _renderHighlightsForPage(pw); });
  }

  function _renderHighlightsForPage(pw) {
    // Remove old highlights
    pw.wrapper.querySelectorAll(".pdf-highlight").forEach(el => el.remove());
    const pageHL = _highlights.filter(h => h.pageNum === pw.num);
    const w = pw.wrapper.offsetWidth, h = pw.wrapper.offsetHeight;
    pageHL.forEach(hl => {
      (hl.rects || []).forEach(r => {
        const div = document.createElement("div");
        div.className = "pdf-highlight";
        div.style.left = (r.x * w) + "px";
        div.style.top = (r.y * h) + "px";
        div.style.width = (r.w * w) + "px";
        div.style.height = (r.h * h) + "px";
        div.style.background = (hl.color || "rgba(251,191,36,0.3)");
        pw.wrapper.appendChild(div);
      });
    });
  }

  function _setupScrollListener() {
    if (!_container) return;
    _boundScrollFn = () => {
      clearTimeout(_scrollTimer);
      _scrollTimer = setTimeout(() => {
        const info = getCurrentPage();
        _updateToolbarInfo();
        if (_onPageScroll) _onPageScroll(info.pageNum, info.yPosition);
      }, 80);
    };
    _container.addEventListener("scroll", _boundScrollFn);
  }

  let _mouseDownPos = null; // track drag start for visual selection

  // Check if a DOM node is inside the PDF pages area (handles stale references)
  function _isInsidePdf(node) {
    if (!node) return false;
    // Walk up from node to check for .pdf-pages or #pdfPages
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el) {
      if (el === _pagesEl) return true;
      if (el.id === "pdfPages" || el.classList && el.classList.contains("pdf-pages")) return true;
      el = el.parentElement;
    }
    return false;
  }

  // Find the page wrapper from any node inside the PDF
  function _findPageWrapper(node) {
    let el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    while (el) {
      if (el.classList && el.classList.contains("pdf-page-wrapper")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function _setupSelectionListener() {
    // Track mousedown position for visual-area-based text extraction
    _boundMouseDownFn = (e) => {
      if (_isInsidePdf(e.target)) {
        _mouseDownPos = { x: e.clientX, y: e.clientY };
      } else {
        _mouseDownPos = null;
      }
    };
    document.addEventListener("mousedown", _boundMouseDownFn);

    // Core selection handler — shared between mouseup and selectionchange
    function _handleSelection(mouseEvt) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const selText = sel.toString().trim();
      if (!selText || selText.length < 1) return;

      // Find page wrapper — try multiple strategies
      const range = sel.getRangeAt(0);
      let pageWrapper = _findPageWrapper(range.commonAncestorContainer)
                     || _findPageWrapper(range.startContainer)
                     || _findPageWrapper(sel.anchorNode);

      // If mouseEvt provided, also try from event target
      if (!pageWrapper && mouseEvt) {
        pageWrapper = _findPageWrapper(mouseEvt.target);
      }

      // Must be inside PDF
      if (!pageWrapper) return;

      let text = "", rects = [];
      const downPos = mouseEvt ? null : _mouseDownPos; // only use downPos for mouseup path

      // Strategy 1: visual drag rectangle (only when we have drag coordinates)
      if (mouseEvt && _mouseDownPos && pageWrapper) {
        const dp = _mouseDownPos;
        const dragRect = {
          left: Math.min(dp.x, mouseEvt.clientX) - 5,
          right: Math.max(dp.x, mouseEvt.clientX) + 5,
          top: Math.min(dp.y, mouseEvt.clientY) - 5,
          bottom: Math.max(dp.y, mouseEvt.clientY) + 5
        };
        text = _extractVisualText(pageWrapper, dragRect);
        if (text) rects = _getVisualSelectionRects(pageWrapper, dragRect);
      }

      // Strategy 2: fallback to browser native selection
      if (!text || text.length < 1) {
        text = selText;
        if (pageWrapper) {
          const rangeRects = range.getClientRects();
          const wrapperRect = pageWrapper.getBoundingClientRect();
          rects = Array.from(rangeRects).filter(r => r.width > 0 && r.height > 0).map(r => ({
            x: (r.left - wrapperRect.left) / wrapperRect.width,
            y: (r.top - wrapperRect.top) / wrapperRect.height,
            w: r.width / wrapperRect.width,
            h: r.height / wrapperRect.height
          }));
        }
      }

      if (!text || text.length < 1) return;

      const pageNum = parseInt(pageWrapper.dataset.page) || 1;
      const wrapperRect = pageWrapper.getBoundingClientRect();

      // Position menu at end of selection
      let menuX, menuY;
      const clientRects = range.getClientRects();
      if (clientRects.length > 0) {
        const last = clientRects[clientRects.length - 1];
        menuX = last.right;
        menuY = last.bottom + 4;
      } else if (mouseEvt) {
        menuX = mouseEvt.clientX;
        menuY = mouseEvt.clientY;
      } else {
        // selectionchange path — use wrapper center as fallback
        menuX = wrapperRect.left + wrapperRect.width / 2;
        menuY = wrapperRect.top + wrapperRect.height / 2;
      }

      const yPos = mouseEvt
        ? Math.max(0, Math.min(1, (mouseEvt.clientY - wrapperRect.top) / wrapperRect.height))
        : (rects.length > 0 ? rects[0].y : 0.5);

      if (_onTextSelect) {
        _onTextSelect(text, pageNum, rects, yPos, menuX, menuY);
      }
    }

    _boundMouseUpFn = (e) => {
      // Only handle left-click (button 0); leave right-click to browser
      if (e.button !== 0) return;
      // Delay to let browser finalize selection
      setTimeout(() => _handleSelection(e), 80);
    };
    document.addEventListener("mouseup", _boundMouseUpFn);

    // Fallback: selectionchange fires reliably even when mouseup is suppressed
    let _selChangeTimer = null;
    document.addEventListener("selectionchange", () => {
      clearTimeout(_selChangeTimer);
      _selChangeTimer = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const text = sel.toString().trim();
        if (!text || text.length < 2) return;
        // Only trigger if selection is inside PDF
        const range = sel.getRangeAt(0);
        if (!_findPageWrapper(range.commonAncestorContainer) && !_findPageWrapper(sel.anchorNode)) return;
        _handleSelection(null);
      }, 300); // longer delay to avoid firing during active drag
    });
  }

  // Extract text from spans whose bounding boxes visually overlap the drag area.
  // This avoids the browser selection issue where absolutely-positioned spans
  // get selected in DOM order rather than visual order.
  function _extractVisualText(pageWrapper, dragRect) {
    if (!pageWrapper) return "";
    const textLayer = pageWrapper.querySelector(".pdfjs-text-layer");
    if (!textLayer) return "";

    const spans = textLayer.querySelectorAll("span");
    const items = []; // {top, left, text}
    for (const span of spans) {
      const txt = span.textContent;
      if (!txt || txt.length === 0) continue;
      const r = span.getBoundingClientRect();
      // Use span's vertical midpoint for line-precise filtering
      const midY = (r.top + r.bottom) / 2;
      if (r.right < dragRect.left || r.left > dragRect.right ||
          midY < dragRect.top || midY > dragRect.bottom) continue;
      items.push({ top: r.top, left: r.left, right: r.right, text: txt });
    }
    if (items.length === 0) return "";

    // Sort by visual position: top first, then left
    items.sort((a, b) => {
      const rowDiff = a.top - b.top;
      if (Math.abs(rowDiff) > 5) return rowDiff; // different lines (>5px apart)
      return a.left - b.left; // same line, sort left to right
    });

    // Join: add space between items, newline between lines
    let result = "";
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (i > 0) {
        const prev = items[i - 1];
        if (Math.abs(item.top - prev.top) > 5) {
          result += " "; // line break → space
        } else if (item.left > prev.right + 1) {
          result += " "; // gap between words
        }
      }
      result += item.text;
    }
    return result.replace(/\s+/g, " ").trim();
  }

  // Get normalized highlight rects for visually-selected spans
  function _getVisualSelectionRects(pageWrapper, dragRect) {
    if (!pageWrapper) return [];
    const textLayer = pageWrapper.querySelector(".pdfjs-text-layer");
    if (!textLayer) return [];
    const wRect = pageWrapper.getBoundingClientRect();
    const spans = textLayer.querySelectorAll("span");
    const result = [];
    for (const span of spans) {
      if (!span.textContent || span.textContent.length === 0) continue;
      const r = span.getBoundingClientRect();
      const midY = (r.top + r.bottom) / 2;
      if (r.right < dragRect.left || r.left > dragRect.right ||
          midY < dragRect.top || midY > dragRect.bottom) continue;
      // Clip span rect to drag selection bounds (so only selected portion highlights)
      const clippedLeft = Math.max(r.left, dragRect.left);
      const clippedRight = Math.min(r.right, dragRect.right);
      result.push({
        x: (clippedLeft - wRect.left) / wRect.width,
        y: (r.top - wRect.top) / wRect.height,
        w: (clippedRight - clippedLeft) / wRect.width,
        h: r.height / wRect.height
      });
    }
    return result;
  }

  function _updateToolbarInfo() {
    const label = document.getElementById("pdfZoomLabel");
    if (label) label.textContent = Math.round(_scale * 100) + "%";
    const pageLabel = document.getElementById("pdfPageLabel");
    if (pageLabel && _doc) {
      const info = getCurrentPage();
      pageLabel.textContent = "P." + info.pageNum + " / " + _doc.numPages;
    }
  }

  // Called when panel resizes — re-fit PDF to new container width
  function handleResize() {
    if (!_container || !_doc) return;
    const containerW = _container.clientWidth - 32;
    if (containerW < 100) return;
    _doc.getPage(1).then(page => {
      const vp = page.getViewport({ scale: 1.0 });
      const newScale = containerW / vp.width;
      if (Math.abs(newScale - _scale) > 0.02) {
        setScale(newScale);
      }
    });
  }

  // Extract text content from a specific page (for close reading)
  async function getPageText(pageNum) {
    if (!_doc || pageNum < 1 || pageNum > _doc.numPages) return "";
    const page = await _doc.getPage(pageNum);
    const content = await page.getTextContent();
    return content.items.map(item => item.str).join(" ");
  }

  // Expose global API
  window.PdfViewer = {
    init, loadFromURL, loadFromBlob, loadFromArrayBuffer, destroy,
    setScale, zoomIn, zoomOut, zoomFit, getScale, getNumPages,
    scrollToPage, getCurrentPage, renderHighlights,
    handleResize, getPageText
  };
})();
