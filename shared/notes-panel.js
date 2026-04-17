/**
 * NotesPanel — Right-side notes panel with page-anchored notes,
 * text selection context menu, and highlight management.
 * Exposes global window.NotesPanel.
 */
(function() {
  let _container = null, _listEl = null, _inputEl = null;
  let _notes = [], _paperId = null;
  let _currentPage = 1, _currentY = 0;
  let _onNotesChange = null, _onAddWord = null;
  let _menuEl = null;
  let _pendingAnchor = null; // {pageNum, yPosition, highlightText, rects}
  let _paperInfo = null;     // {title, authors, year} for LaTeX export

  let _closeMenuFn = null;

  function init(containerEl, opts) {
    _container = containerEl;
    _onNotesChange = opts.onNotesChange || null;
    _onAddWord = opts.onAddWord || null;
    // Prevent duplicate menu elements on re-init
    if (_menuEl) { _menuEl.remove(); _menuEl = null; }
    if (_closeMenuFn) { document.removeEventListener("mousedown", _closeMenuFn); _closeMenuFn = null; }
    _createMenu();
    // Close menu on click outside
    _closeMenuFn = (e) => {
      if (_menuEl && !_menuEl.contains(e.target)) hideContextMenu();
    };
    document.addEventListener("mousedown", _closeMenuFn);
  }

  function loadNotes(paperId, notes, paperInfo) {
    _paperId = paperId;
    _notes = notes || [];
    _paperInfo = paperInfo || null;
    renderNotes();
  }

  function renderPanel() {
    if (!_container) return;
    _container.innerHTML =
      '<div class="notes-header"><h3>📝 笔记</h3><span class="note-count-badge" id="noteCountBadge">' + _notes.length + ' 条</span>' +
        '<button class="latex-btn" onclick="NotesPanel.exportLatex()" title="导出 LaTeX">📋 LaTeX</button>' +
        '<button class="latex-btn" onclick="NotesPanel.exportMarkdown()" title="导出 Markdown">📄 MD</button>' +
        '<button class="latex-btn" onclick="NotesPanel.importMarkdown()" title="导入 Markdown 笔记">📥 导入</button>' +
        '<button class="latex-btn" onclick="NotesPanel.resetScrollPosition()" title="同步到PDF当前位置">🔄 复位</button></div>' +
      '<div class="notes-list" id="notesList"></div>' +
      '<div class="note-input-area">' +
        '<textarea id="noteInputTA" placeholder="添加笔记... (Ctrl+Enter 提交)"></textarea>' +
        '<div class="note-input-actions">' +
          '<button class="btn primary" style="font-size:11px;padding:4px 10px" onclick="NotesPanel.submitNote()">添加</button>' +
          '<button class="btn green" style="font-size:11px;padding:4px 10px" onclick="NotesPanel.triggerAddWord()">📚 加词</button>' +
        '</div>' +
      '</div>';
    _listEl = document.getElementById("notesList");
    _inputEl = document.getElementById("noteInputTA");
    if (_inputEl) {
      _inputEl.addEventListener("keydown", e => {
        if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); submitNote(); }
      });
    }
    renderNotes();
  }

  function renderNotes() {
    if (!_listEl) return;
    // Sort by pageNum, then yPosition
    const sorted = [..._notes].sort((a, b) => {
      const pa = a.pageNum || 1, pb = b.pageNum || 1;
      if (pa !== pb) return pa - pb;
      return (a.yPosition || 0.5) - (b.yPosition || 0.5);
    });

    if (!sorted.length) {
      _listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#475569;font-size:12px">选中PDF文字可添加笔记</div>';
      return;
    }

    _listEl.innerHTML = sorted.map(n => {
      const pg = n.pageNum || 1;
      const isActive = pg === _currentPage;
      return '<div class="note-card' + (isActive ? ' active-page' : '') + '" data-note-id="' + n.id + '" data-page="' + pg + '">' +
        '<span class="note-page-badge">P.' + pg + '</span>' +
        (n.highlightText ? '<div class="note-highlight-quote">' + esc(n.highlightText) + '</div>' : '') +
        '<div class="note-text">' + esc(n.text) + '</div>' +
        '<div class="note-meta">' + _formatTime(n.ts) + '</div>' +
        '<span class="note-del" onclick="NotesPanel.deleteNote(\'' + n.id + '\')">✕</span>' +
      '</div>';
    }).join("");

    // Update count
    const badge = document.getElementById("noteCountBadge");
    if (badge) badge.textContent = _notes.length + " 条";
  }

  function syncScroll(pageNum, yPosition) {
    _currentPage = pageNum;
    _currentY = yPosition;
    if (!_listEl) return;
    // Highlight notes on current page
    _listEl.querySelectorAll(".note-card").forEach(card => {
      const p = parseInt(card.dataset.page) || 1;
      card.classList.toggle("active-page", p === pageNum);
    });
    // Scroll to first note on current page
    const target = _listEl.querySelector('.note-card[data-page="' + pageNum + '"]');
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  // Reset notes scroll to match current PDF position (called by user button)
  function resetScrollPosition() {
    if (!window.PdfViewer) return;
    const info = PdfViewer.getCurrentPage();
    syncScroll(info.pageNum, info.yPosition);
  }

  function addNote(text, pageNum, yPosition, highlightText, highlightRects, color) {
    const note = {
      id: uid(),
      text: text,
      ts: Date.now(),
      pageNum: pageNum || _currentPage || 1,
      yPosition: yPosition || _currentY || 0.5
    };
    if (highlightText) note.highlightText = highlightText;
    if (highlightRects && highlightRects.length) note.highlightRects = highlightRects;
    if (color) note.color = color;
    _notes.push(note);
    renderNotes();
    _fireChange();
  }

  function deleteNote(noteId) {
    _notes = _notes.filter(n => n.id !== noteId);
    renderNotes();
    _fireChange();
  }

  function submitNote() {
    if (!_inputEl) return;
    const text = _inputEl.value.trim();
    if (!text) return;
    const anchor = _pendingAnchor || {};
    addNote(text, anchor.pageNum, anchor.yPosition, anchor.highlightText, anchor.rects);
    _inputEl.value = "";
    _pendingAnchor = null;
    _inputEl.placeholder = "添加笔记... (Ctrl+Enter 提交)";
  }

  function triggerAddWord() {
    if (_onAddWord) _onAddWord("", "");
  }

  // === Context Menu ===
  function _createMenu() {
    _menuEl = document.createElement("div");
    _menuEl.className = "text-select-menu";
    _menuEl.innerHTML =
      '<button onclick="NotesPanel._menuAction(\'note\')">📝 笔记</button>' +
      '<button onclick="NotesPanel._menuAction(\'vocab\')">📚 词库</button>' +
      '<button onclick="NotesPanel._menuAction(\'highlight\')">🖍 高亮</button>';
    document.body.appendChild(_menuEl);
  }

  let _menuContext = null; // {text, pageNum, rects, yPos}

  function showContextMenu(x, y, text, pageNum, rects, yPos) {
    if (!_menuEl || !text) return;
    _menuContext = { text, pageNum, rects, yPos };
    _menuEl.style.left = Math.min(x, window.innerWidth - 280) + "px";
    _menuEl.style.top = Math.min(y - 40, window.innerHeight - 50) + "px";
    _menuEl.classList.add("show");
  }

  function hideContextMenu() {
    if (_menuEl) _menuEl.classList.remove("show");
    _menuContext = null;
  }

  function _menuAction(action) {
    if (!_menuContext) return;
    const { text, pageNum, rects, yPos } = _menuContext;
    hideContextMenu();

    switch (action) {
      case "note":
        // Set pending anchor and focus input
        _pendingAnchor = { pageNum, yPosition: yPos, highlightText: text, rects };
        if (_inputEl) {
          _inputEl.placeholder = "对 \"" + text.slice(0, 30) + (text.length > 30 ? "..." : "") + "\" 添加笔记...";
          _inputEl.focus();
        }
        break;
      case "vocab":
        if (_onAddWord) _onAddWord(text, text);
        break;
      case "highlight":
        // Create highlight-only note
        addNote("", pageNum, yPos, text, rects, "rgba(251,191,36,0.3)");
        break;
    }
    window.getSelection()?.removeAllRanges();
  }

  function _fireChange() {
    if (_onNotesChange) _onNotesChange(_paperId, _notes);
  }

  // Use global esc() / uid() from utils.js
  function _formatTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  // ── LaTeX export ──
  function exportLatex() {
    if (!_notes.length) { showToast("没有笔记可导出"); return; }
    const sorted = [..._notes].sort((a, b) => {
      const pa = a.pageNum || 1, pb = b.pageNum || 1;
      if (pa !== pb) return pa - pb;
      return (a.yPosition || 0.5) - (b.yPosition || 0.5);
    });
    const info = _paperInfo || {};
    let tex = "% Notes from: " + (info.title || "Unknown Paper") + "\n";
    if (info.authors) tex += "% Authors: " + info.authors + "\n";
    if (info.year) tex += "% Year: " + info.year + "\n";
    tex += "% Exported: " + new Date().toISOString().slice(0, 10) + "\n\n";
    tex += "\\begin{enumerate}\n";
    sorted.forEach(n => {
      tex += "  \\item \\textbf{P." + (n.pageNum || 1) + "}";
      if (n.highlightText) {
        tex += " \\emph{``" + _texEsc(n.highlightText) + "''}\n";
      }
      if (n.text) {
        tex += "\n  \n  " + _texEsc(n.text) + "\n";
      }
      tex += "\n";
    });
    tex += "\\end{enumerate}\n";

    navigator.clipboard.writeText(tex).then(() => {
      showToast("✅ LaTeX 已复制到剪贴板");
    }).catch(() => {
      // Fallback: show in a textarea
      prompt("复制以下 LaTeX 内容:", tex);
    });
  }

  // ── Markdown export ──
  function exportMarkdown() {
    if (!_notes.length) { showToast("没有笔记可导出"); return; }
    const sorted = [..._notes].sort((a, b) => {
      const pa = a.pageNum || 1, pb = b.pageNum || 1;
      if (pa !== pb) return pa - pb;
      return (a.yPosition || 0.5) - (b.yPosition || 0.5);
    });
    const info = _paperInfo || {};
    let md = "# " + (info.title || "Reading Notes") + "\n\n";
    if (info.authors) md += "**Authors:** " + info.authors + "\n\n";
    if (info.year) md += "**Year:** " + info.year + "\n\n";
    md += "---\n\n";

    let lastPage = 0;
    sorted.forEach(n => {
      const pg = n.pageNum || 1;
      if (pg !== lastPage) { md += "## Page " + pg + "\n\n"; lastPage = pg; }
      if (n.highlightText) md += "> " + n.highlightText.replace(/\n/g, "\n> ") + "\n\n";
      if (n.text) md += n.text + "\n\n";
    });

    md += "---\n*Exported: " + new Date().toISOString().slice(0, 10) + "*\n";

    navigator.clipboard.writeText(md).then(() => {
      showToast("Markdown 已复制到剪贴板");
    }).catch(() => {
      prompt("复制以下 Markdown:", md);
    });
  }

  // ── Markdown import ──
  function importMarkdown() {
    if (!_paperId) { showToast("请先打开一篇论文"); return; }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.txt,.json";
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();

      // Try JSON first (array of note objects)
      try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr)) {
          const count = _importNoteArray(arr);
          showToast("✅ 导入 " + count + " 条笔记");
          return;
        }
      } catch(e) { /* not JSON, try Markdown */ }

      // Parse Markdown: ## headings as sections, > blockquotes as highlights, text as notes
      const lines = text.split("\n");
      let currentPage = 1;
      let pendingHighlight = "";
      let pendingText = [];
      let imported = 0;

      function flushNote() {
        const noteText = pendingText.join("\n").trim();
        if (noteText || pendingHighlight) {
          _notes.push({
            id: uid(),
            text: noteText,
            ts: Date.now(),
            pageNum: currentPage,
            yPosition: 0.5,
            highlightText: pendingHighlight || ""
          });
          imported++;
        }
        pendingHighlight = "";
        pendingText = [];
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // ## Page N or ## 第N页 or ## Section title
        const pageMatch = line.match(/^##\s+(?:Page\s+|P\.|第)(\d+)/i);
        const sectionMatch = line.match(/^##\s+(.+)/);

        if (pageMatch) {
          flushNote();
          currentPage = parseInt(pageMatch[1]) || currentPage;
        } else if (sectionMatch && !pageMatch) {
          flushNote();
          // Section heading becomes a note
          pendingText.push("【" + sectionMatch[1].trim() + "】");
        } else if (line.startsWith("> ")) {
          // Blockquote = highlight
          if (pendingHighlight) pendingHighlight += "\n";
          pendingHighlight += line.slice(2);
        } else if (line.startsWith("# ") || line.startsWith("---") || line.startsWith("*Exported")) {
          // Skip title, separators, export timestamp
          continue;
        } else if (line.startsWith("**") && line.includes(":**")) {
          // Metadata like **Authors:** ... — skip
          continue;
        } else if (line.trim() === "") {
          // Blank line — flush if we have content
          if (pendingText.length || pendingHighlight) flushNote();
        } else {
          pendingText.push(line);
        }
      }
      flushNote(); // flush remaining

      if (imported === 0) {
        // Fallback: import entire file as one note
        _notes.push({
          id: uid(), text: text.trim(), ts: Date.now(),
          pageNum: 1, yPosition: 0.5, highlightText: ""
        });
        imported = 1;
      }

      renderNotes();
      _fireChange();
      showToast("✅ 导入 " + imported + " 条笔记（Markdown）");
    };
    input.click();
  }

  function _importNoteArray(arr) {
    let count = 0;
    arr.forEach(n => {
      if (n.text || n.highlightText) {
        _notes.push({
          id: uid(),
          text: n.text || "",
          ts: n.ts || Date.now(),
          pageNum: n.pageNum || 1,
          yPosition: n.yPosition || 0.5,
          highlightText: n.highlightText || "",
          highlightRects: n.highlightRects || undefined,
          color: n.color || undefined
        });
        count++;
      }
    });
    renderNotes();
    _fireChange();
    return count;
  }

  function _texEsc(s) {
    if (!s) return "";
    // Placeholder for backslash to avoid double-escaping its braces
    return s.replace(/\\/g, "\x00BKSL\x00")
      .replace(/[&%$#_{}~^]/g, m => "\\" + m)
      .replace(/\x00BKSL\x00/g, "\\textbackslash{}")
      .replace(/\n/g, "\\\\\n");
  }

  window.NotesPanel = {
    init, loadNotes, renderPanel, renderNotes, syncScroll, resetScrollPosition,
    addNote, deleteNote, submitNote, triggerAddWord,
    showContextMenu, hideContextMenu, exportLatex, exportMarkdown, importMarkdown,
    _menuAction // exposed for onclick in menu HTML
  };
})();
