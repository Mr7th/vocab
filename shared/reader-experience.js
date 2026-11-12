/** Local reader preferences: compact tags and a reversible PDF focus view. */
(function () {
  const KEY = "fsi_reader_tag_preferences";
  let preferences = { expanded: false, pinned: [] }, query = "";
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved) preferences = { expanded: saved.expanded === true, pinned: Array.isArray(saved.pinned) ? saved.pinned.filter(x => typeof x === "string") : [] };
  } catch (_) {}
  let focus = false;
  function save() { try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch (_) {} }
  function updateTags() {
    const bar = document.getElementById("sortFilterBar");
    if (!bar) return;
    const tags = bar.querySelector(".sf-tags");
    if (!tags) return;
    let controls = bar.querySelector(".tag-browser-controls");
    if (!controls) {
      controls = document.createElement("div"); controls.className = "tag-browser-controls";
      controls.innerHTML = '<div class="tag-browser-heading"><strong>标签</strong><button type="button" class="tag-expand"></button></div><input class="tag-search" type="search" placeholder="搜索标签…" aria-label="搜索标签">';
      bar.insertBefore(controls, tags);
      controls.querySelector(".tag-search").value = query;
      controls.querySelector(".tag-search").addEventListener("input", e => { query = e.target.value; updateTags(); });
      controls.querySelector(".tag-expand").addEventListener("click", () => { preferences.expanded = !preferences.expanded; save(); updateTags(); });
    }
    const chips = Array.from(tags.querySelectorAll(".sf-tag-chip[data-drag-tag]"));
    const term = query.trim().toLowerCase();
    let visible = 0;
    const order = new Map(_getAllCategoryTags().map(([tag], index) => [tag, index]));
    chips.sort((a,b) => Number(preferences.pinned.includes(decodeURIComponent(b.dataset.dragTag))) - Number(preferences.pinned.includes(decodeURIComponent(a.dataset.dragTag))) || order.get(decodeURIComponent(a.dataset.dragTag)) - order.get(decodeURIComponent(b.dataset.dragTag)));
    chips.forEach((chip, index) => {
      const tag = decodeURIComponent(chip.dataset.dragTag);
      const pinned = preferences.pinned.includes(tag);
      let pin = chip.querySelector(".sf-tag-pin");
      if (!pin) {
        pin = document.createElement("button"); pin.type = "button"; pin.className = "sf-tag-pin"; pin.draggable = false;
        pin.addEventListener("click", e => {
          e.preventDefault(); e.stopPropagation();
          preferences.pinned = preferences.pinned.includes(tag) ? preferences.pinned.filter(t => t !== tag) : [...preferences.pinned, tag];
          save(); updateTags();
        });
        chip.insertBefore(pin, chip.firstChild);
      }
      pin.textContent = pinned ? "★" : "☆";
      pin.title = pinned ? "取消置顶 #" + tag : "置顶 #" + tag;
      pin.setAttribute("aria-label", pin.title); pin.setAttribute("aria-pressed", String(pinned));
      chip.classList.toggle("tag-pinned", pinned);
      chip.hidden = term ? !tag.toLowerCase().includes(term) : !(preferences.expanded || pinned || chip.classList.contains("active") || index < 6);
      if (!chip.hidden) visible++;
      tags.appendChild(chip);
    });
    // Keep the existing clear-filter action after the chips.
    const clear = tags.querySelector(".sf-tag-clear"); if (clear) tags.appendChild(clear);
    const toggle = controls.querySelector(".tag-expand");
    toggle.textContent = preferences.expanded ? "收起" : "展开全部（" + chips.length + "）";
    toggle.setAttribute("aria-expanded", String(preferences.expanded));
    let empty = bar.querySelector(".tag-search-empty");
    if (!empty) { empty = document.createElement("div"); empty.className = "tag-search-empty"; empty.textContent = "没有匹配的标签"; tags.after(empty); }
    empty.hidden = visible > 0 || !term;
  }
  function updateFocusButton() {
    const toolbar = document.querySelector("#pdfContainer .pdf-toolbar");
    if (!toolbar) return;
    let button = toolbar.querySelector(".reader-focus-toggle");
    if (!button) {
      button = document.createElement("button"); button.type = "button"; button.className = "reader-focus-toggle";
      button.addEventListener("click", () => {
        const position = PdfViewer.getCurrentPage();
        focus = !focus; document.body.classList.toggle("reader-focus", focus);
        NotesPanel.hideContextMenu(); updateFocusButton();
        requestAnimationFrame(() => {
          PdfViewer.scrollToPage(position.pageNum, position.yPosition, "auto");
          PdfViewer.saveReadingProgress();
        });
      });
      toolbar.insertBefore(button, toolbar.querySelector(".page-label"));
    }
    button.textContent = focus ? "退出专注" : "专注阅读";
    button.setAttribute("aria-pressed", String(focus));
    button.title = focus ? "恢复摘要、笔记和原面板布局" : "收起摘要、总结、引用与其他面板，专注 PDF";
  }
  const renderTags = window.renderSortFilterBar;
  window.renderSortFilterBar = function () { const result = renderTags.apply(this, arguments); updateTags(); return result; };
  const renderDetail = window.renderPaperDetail;
  window.renderPaperDetail = function () {
    PdfViewer.saveReadingProgress();
    const result = renderDetail.apply(this, arguments);
    updateFocusButton(); return result;
  };
  const select = window.selectPaper;
  window.selectPaper = function () { PdfViewer.saveReadingProgress(); return select.apply(this, arguments); };
  const welcome = window.renderWelcome;
  window.renderWelcome = function () {
    PdfViewer.saveReadingProgress(); PdfViewer.destroy();
    focus = false; document.body.classList.remove("reader-focus");
    return welcome.apply(this, arguments);
  };
  updateTags(); updateFocusButton();
})();
