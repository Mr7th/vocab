/**
 * FolderManager — Folder/category system for papers.
 * Exposes global window.FolderManager.
 */
(function() {
  const STORAGE_KEY = "fsi_folders_data";
  let _folders = [], _activeFolderId = null;
  let _container = null, _onFilterChange = null;

  function init(containerEl, opts) {
    _container = containerEl;
    _onFilterChange = opts.onFilterChange || null;
    _folders = _loadFromStorage();
  }

  function _loadFromStorage() {
    try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) return JSON.parse(raw); } catch(e) {}
    return [];
  }

  function _saveToStorage() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_folders));
  }

  function getFolders() { return _folders; }

  function loadFolders(folders) {
    _folders = folders || [];
    _saveToStorage();
  }

  function createFolder(name, emoji) {
    const folder = {
      id: "f_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || "新文件夹",
      emoji: emoji || "📁",
      order: _folders.length
    };
    _folders.push(folder);
    _saveToStorage();
    return folder;
  }

  function renameFolder(folderId, newName) {
    const f = _folders.find(x => x.id === folderId);
    if (f) { f.name = newName; _saveToStorage(); }
  }

  function deleteFolder(folderId) {
    _folders = _folders.filter(f => f.id !== folderId);
    _saveToStorage();
    if (_activeFolderId === folderId) {
      _activeFolderId = null;
      if (_onFilterChange) _onFilterChange(null);
    }
  }

  function setActiveFolder(folderId) {
    _activeFolderId = folderId;
    if (_onFilterChange) _onFilterChange(folderId);
  }

  function getActiveFolder() { return _activeFolderId; }

  function renderFolderTree(papers) {
    if (!_container) return;
    const allCount = papers.length;
    const uncatCount = papers.filter(p => !p.folderId).length;
    const counts = {};
    papers.forEach(p => { if (p.folderId) counts[p.folderId] = (counts[p.folderId] || 0) + 1; });

    let html = '<div class="folder-tree">';
    // "All" item
    html += '<div class="folder-item' + (!_activeFolderId ? ' active' : '') + '" onclick="FolderManager.setActiveFolder(null);FolderManager.renderFolderTree(window._PAPERS_REF || [])">' +
      '<span>📚</span><span class="folder-name">全部论文</span><span class="folder-count">' + allCount + '</span></div>';

    // Each folder
    _folders.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(f => {
      const c = counts[f.id] || 0;
      const active = _activeFolderId === f.id;
      html += '<div class="folder-item' + (active ? ' active' : '') + '" draggable="true" data-folder-id="' + f.id + '"' +
        ' onclick="FolderManager.setActiveFolder(\'' + f.id + '\');FolderManager.renderFolderTree(window._PAPERS_REF || [])"' +
        ' oncontextmenu="FolderManager._showFolderMenu(event,\'' + f.id + '\')">' +
        '<span>' + (f.emoji || "📁") + '</span><span class="folder-name">' + esc(f.name) + '</span>' +
        '<span class="folder-count">' + c + '</span></div>';
    });

    // Uncategorized
    if (uncatCount > 0 && _folders.length > 0) {
      const active = _activeFolderId === "__uncat__";
      html += '<div class="folder-item' + (active ? ' active' : '') + '" onclick="FolderManager.setActiveFolder(\'__uncat__\');FolderManager.renderFolderTree(window._PAPERS_REF || [])">' +
        '<span>📄</span><span class="folder-name">未分类</span><span class="folder-count">' + uncatCount + '</span></div>';
    }

    html += '<button class="folder-add-btn" onclick="FolderManager.promptCreateFolder()">+ 新建文件夹</button>';
    html += '</div>';
    _container.innerHTML = html;
    _setupFolderDrag(papers);
  }

  function _setupFolderDrag(papers) {
    let dragSrcId = null;
    _container.querySelectorAll(".folder-item[draggable]").forEach(item => {
      item.addEventListener("dragstart", function(e) {
        dragSrcId = this.dataset.folderId;
        this.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragSrcId);
      });
      item.addEventListener("dragend", function() {
        this.classList.remove("dragging");
        _container.querySelectorAll(".folder-item.drag-over").forEach(el => el.classList.remove("drag-over"));
      });
      item.addEventListener("dragover", function(e) {
        e.preventDefault(); e.dataTransfer.dropEffect = "move";
        this.classList.add("drag-over");
      });
      item.addEventListener("dragleave", function() { this.classList.remove("drag-over"); });
      item.addEventListener("drop", function(e) {
        e.preventDefault(); this.classList.remove("drag-over");
        const targetId = this.dataset.folderId;
        if (!dragSrcId || !targetId || dragSrcId === targetId) return;
        const srcIdx = _folders.findIndex(f => f.id === dragSrcId);
        const tgtIdx = _folders.findIndex(f => f.id === targetId);
        if (srcIdx < 0 || tgtIdx < 0) return;
        const moved = _folders.splice(srcIdx, 1)[0];
        _folders.splice(tgtIdx, 0, moved);
        _folders.forEach((f, i) => f.order = i);
        _saveToStorage();
        renderFolderTree(papers);
        if (typeof debouncedPush === "function") debouncedPush("文件夹排序");
      });
    });
  }

  function promptCreateFolder() {
    _showFolderModal("create");
  }

  function _showFolderMenu(e, folderId) {
    e.preventDefault();
    e.stopPropagation();
    _showFolderModal("menu", folderId);
  }

  function _showFolderModal(mode, folderId) {
    let existing = document.getElementById("folderModal");
    if (existing) existing.remove();

    const folder = folderId ? _folders.find(f => f.id === folderId) : null;
    const overlay = document.createElement("div");
    overlay.id = "folderModal";
    overlay.className = "modal-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center";

    let html = '<div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;width:320px;max-width:90vw">';

    if (mode === "create") {
      html += '<div style="font-size:14px;font-weight:600;color:#f1f5f9;margin-bottom:16px">新建文件夹</div>';
      html += '<input id="fmName" style="width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 10px;color:#e2e8f0;font-size:13px;margin-bottom:10px" placeholder="文件夹名称">';
      html += '<input id="fmEmoji" style="width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 10px;color:#e2e8f0;font-size:13px;margin-bottom:16px" placeholder="图标 emoji（留空默认 📁）" value="📁">';
      html += '<div style="display:flex;gap:8px;justify-content:flex-end">';
      html += '<button id="fmCancel" style="background:#334155;color:#94a3b8;border:none;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:13px">取消</button>';
      html += '<button id="fmOk" style="background:#0ea5e9;color:#fff;border:none;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:13px">创建</button>';
      html += '</div>';
    } else {
      html += '<div style="font-size:14px;font-weight:600;color:#f1f5f9;margin-bottom:16px">' + esc((folder ? folder.emoji : '') + ' ' + (folder ? folder.name : '')) + '</div>';
      html += '<input id="fmName" style="width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 10px;color:#e2e8f0;font-size:13px;margin-bottom:16px" placeholder="输入新名称以重命名" value="' + esc(folder ? folder.name : '') + '">';
      html += '<div style="display:flex;gap:8px;justify-content:flex-end">';
      html += '<button id="fmDel" style="background:#7f1d1d;color:#fca5a5;border:none;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:13px">删除文件夹</button>';
      html += '<button id="fmCancel" style="background:#334155;color:#94a3b8;border:none;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:13px">取消</button>';
      html += '<button id="fmOk" style="background:#0ea5e9;color:#fff;border:none;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:13px">重命名</button>';
      html += '</div>';
    }
    html += '</div>';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) overlay.remove(); });
    document.getElementById("fmCancel").addEventListener("click", () => overlay.remove());

    if (mode === "create") {
      document.getElementById("fmName").focus();
      document.getElementById("fmOk").addEventListener("click", () => {
        const name = document.getElementById("fmName").value.trim();
        if (!name) return;
        const emoji = document.getElementById("fmEmoji").value.trim() || "📁";
        createFolder(name, emoji);
        renderFolderTree(window._PAPERS_REF || []);
        if (_onFilterChange) _onFilterChange(_activeFolderId);
        overlay.remove();
      });
      document.getElementById("fmName").addEventListener("keydown", (ev) => { if (ev.key === "Enter") document.getElementById("fmOk").click(); });
    } else {
      document.getElementById("fmName").focus();
      document.getElementById("fmName").select();
      document.getElementById("fmOk").addEventListener("click", () => {
        const newName = document.getElementById("fmName").value.trim();
        if (newName && newName !== folder.name) {
          renameFolder(folderId, newName);
          renderFolderTree(window._PAPERS_REF || []);
        }
        overlay.remove();
      });
      document.getElementById("fmDel").addEventListener("click", () => {
        overlay.innerHTML = '<div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;width:320px;max-width:90vw;text-align:center">' +
          '<div style="font-size:14px;color:#f1f5f9;margin-bottom:16px">确定删除文件夹「' + esc(folder.name) + '」？</div>' +
          '<div style="font-size:12px;color:#64748b;margin-bottom:16px">文件夹内的论文不会被删除，会变为未分类。</div>' +
          '<div style="display:flex;gap:8px;justify-content:center">' +
          '<button id="fmNo" style="background:#334155;color:#94a3b8;border:none;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:13px">取消</button>' +
          '<button id="fmYes" style="background:#dc2626;color:#fff;border:none;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:13px">确认删除</button>' +
          '</div></div>';
        document.getElementById("fmNo").addEventListener("click", () => overlay.remove());
        document.getElementById("fmYes").addEventListener("click", () => {
          deleteFolder(folderId);
          renderFolderTree(window._PAPERS_REF || []);
          overlay.remove();
        });
      });
      document.getElementById("fmName").addEventListener("keydown", (ev) => { if (ev.key === "Enter") document.getElementById("fmOk").click(); });
    }
  }

  function renderFolderPicker(currentFolderId) {
    let html = '<option value="">未分类</option>';
    _folders.forEach(f => {
      html += '<option value="' + f.id + '"' + (currentFolderId === f.id ? ' selected' : '') + '>' + (f.emoji || "📁") + ' ' + esc(f.name) + '</option>';
    });
    return html;
  }

  function mergeFolders(local, remote) {
    if (!remote || !Array.isArray(remote)) return local;
    const merged = [...local];
    remote.forEach(rf => {
      if (!merged.some(lf => lf.id === rf.id)) merged.push(rf);
    });
    return merged;
  }

  function filterPapers(papers, folderId) {
    if (!folderId) return papers;
    if (folderId === "__uncat__") return papers.filter(p => !p.folderId);
    return papers.filter(p => p.folderId === folderId);
  }

  window.FolderManager = {
    init, getFolders, loadFolders, createFolder, renameFolder, deleteFolder,
    setActiveFolder, getActiveFolder, renderFolderTree, promptCreateFolder,
    renderFolderPicker, mergeFolders, filterPapers,
    _showFolderMenu // exposed for oncontextmenu
  };
})();
