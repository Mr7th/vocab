/** Drag existing category labels onto a paper without disturbing its PDF view. */
(function () {
  const TYPE = "application/x-fsi-category-tag";
  let activeTag = null, source = null, hovered = null, suppressClickUntil = 0;
  function clearTarget() {
    if (hovered) { hovered.classList.remove("tag-drop-target"); hovered.removeAttribute("data-tag-drop-hint"); }
    hovered = null;
  }
  function finish() {
    clearTarget();
    if (source) source.classList.remove("tag-drag-source");
    source = null; activeTag = null;
    document.body.classList.remove("dragging-category-tag");
  }
  function targetFor(node) {
    if (!(node instanceof Element)) return null;
    const item = node.closest("#paperList .paper-item[data-paper-id]");
    if (item) return { el: item, id: item.dataset.paperId };
    const detail = node.closest("#mainContent");
    if (detail && currentPaperId && detail.querySelector(".paper-header")) return { el: detail, id: currentPaperId };
    return null;
  }
  function isTagDrag(e) {
    return activeTag !== null && e.dataTransfer && Array.from(e.dataTransfer.types).includes(TYPE);
  }
  document.addEventListener("dragstart", e => {
    const chip = e.target.closest && e.target.closest(".sf-tag-chip[data-drag-tag]");
    if (!chip) return;
    if (e.target.closest(".sf-tag-del, .sf-tag-pin")) { e.preventDefault(); return; }
    activeTag = decodeURIComponent(chip.dataset.dragTag);
    source = chip;
    e.dataTransfer.setData(TYPE, activeTag);
    e.dataTransfer.effectAllowed = "copy";
    chip.classList.add("tag-drag-source");
    document.body.classList.add("dragging-category-tag");
    e.stopPropagation();
  }, true);
  document.addEventListener("click", e => {
    if (Date.now() < suppressClickUntil && e.target.closest && e.target.closest(".sf-tag-chip")) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener("dragover", e => {
    if (!isTagDrag(e)) return;
    const target = targetFor(e.target);
    if (!target) { clearTarget(); return; }
    const paper = PAPERS.find(p => p.id === target.id);
    if (!paper) return;
    e.preventDefault(); e.stopImmediatePropagation();
    e.dataTransfer.dropEffect = "copy";
    if (hovered !== target.el) { clearTarget(); hovered = target.el; }
    hovered.classList.add("tag-drop-target");
    hovered.dataset.tagDropHint = (paper.categoryTags || []).includes(activeTag) ? "已有此标签" : "松开添加 #" + activeTag;
  }, true);
  document.addEventListener("dragleave", e => {
    if (!isTagDrag(e) || !hovered) return;
    if (!e.relatedTarget || !hovered.contains(e.relatedTarget)) clearTarget();
  }, true);
  document.addEventListener("drop", e => {
    if (!isTagDrag(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const tag = activeTag, target = targetFor(e.target);
    suppressClickUntil = Date.now() + 250;
    finish();
    if (!target) return;
    const paper = PAPERS.find(p => p.id === target.id);
    if (!paper) return;
    if ((paper.categoryTags || []).includes(tag)) { showToast("已有标签 #" + tag); return; }
    const previous = paper.categoryTags, timestamp = paper.updatedAt;
    paper.categoryTags = [...(previous || []), tag];
    paper.updatedAt = Date.now();
    try { savePapers(PAPERS); }
    catch (error) {
      paper.categoryTags = previous; paper.updatedAt = timestamp;
      showToast("标签保存失败，请检查浏览器存储空间"); return;
    }
    window._PAPERS_REF = PAPERS;
    renderSortFilterBar(); renderPaperList();
    if (paper.id === currentPaperId) {
      const row = document.querySelector("#mainContent .inline-tags");
      if (row) {
        const pill = document.createElement("span"); pill.className = "cat-tag-pill";
        pill.append(document.createTextNode("#" + tag + " "));
        const remove = document.createElement("span"); remove.className = "tag-x";
        remove.textContent = "✕"; remove.title = "移除标签";
        remove.addEventListener("click", event => { event.stopPropagation(); removeTag(paper.id, tag); });
        pill.append(remove); row.insertBefore(pill, row.querySelector(".add-tag-btn"));
      }
    }
    debouncedPush("拖动添加标签");
    showToast("已添加标签 #" + tag);
  }, true);
  document.addEventListener("dragend", () => {
    if (activeTag !== null) suppressClickUntil = Date.now() + 250;
    finish();
  }, true);
})();
