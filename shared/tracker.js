/* ==================== 文献追踪 - tracker.js v3 (v5.6) ==================== */
/* 摘要预览 · 笔记/阅读状态 · 引用链发现 · 综述分组 */
(function () {
  "use strict";

  const STORAGE_KEY = "fsi_tracker_data";
  const DATA_VERSION = 11;
  const API_BASE = "https://api.openalex.org";
  const CACHE_KEY = "fsi_tracker_cache";
  const CACHE_TTL = 3600000;
  const DEBOUNCE_MS = 400;
  const MAX_ARTICLES = 10;
  const NOTES_KEY = "fsi_tracker_notes";
  const TOPICS_KEY = "fsi_tracker_topics";

  // ==================== Default Data ====================
  const DEFAULT_DATA = {
    journalGroups: [
      { id: "jg1", name: "流体力学", journals: [
        { id: "j1", name: "Journal of Fluid Mechanics", abbr: "JFM", openalex_id: "https://openalex.org/S152000018", url: "https://www.cambridge.org/core/journals/journal-of-fluid-mechanics", articles: [] },
        { id: "j2", name: "Physics of Fluids", abbr: "POF", openalex_id: "https://openalex.org/S22862804", url: "https://pubs.aip.org/aip/pof", articles: [] },
        { id: "j3", name: "Ocean Engineering", abbr: "OE", openalex_id: "https://openalex.org/S76910236", url: "https://www.sciencedirect.com/journal/ocean-engineering", articles: [] },
        { id: "j4", name: "Annual Review of Fluid Mechanics", abbr: "ARFM", openalex_id: "https://openalex.org/S169493037", url: "https://www.annualreviews.org/journal/fluid", articles: [] },
      ]},
      { id: "jg2", name: "综合顶刊", journals: [
        { id: "j5", name: "Nature", abbr: "Nature", openalex_id: "https://openalex.org/S137773608", url: "https://www.nature.com/", articles: [] },
        { id: "j6", name: "Science", abbr: "Science", openalex_id: "https://openalex.org/S3880285", url: "https://www.science.org/journal/science", articles: [] },
      ]},
    ],
    scholarGroups: [
      { id: "g1", name: "导师组", scholars: [
        { id: "s1", name: "An Wang", openalex_id: "https://openalex.org/A5100419962", url: "https://scholar.google.com/citations?user=5S8k51cAAAAJ&hl=en", articles: [] },
        { id: "s2", name: "James H. Duncan", openalex_id: "https://openalex.org/A5080925730", url: "https://openalex.org/A5080925730", articles: [] },
        { id: "s3", name: "Kenneth T. Kiger", openalex_id: "https://openalex.org/A5018960739", url: "https://openalex.org/A5018960739", articles: [] },
      ]},
      { id: "g2", name: "同行", scholars: [] },
      { id: "g3", name: "大佬", scholars: [] },
    ],
    keywordGroups: [
      { id: "k1", label: "流固耦合", terms: "fluid-structure interaction", results: [] },
      { id: "k2", label: "入水砰击", terms: "water impact elastic plate slamming", results: [] },
      { id: "k3", label: "水弹性", terms: "hydroelasticity flexible plate", results: [] },
    ],
    lastRefresh: null,
  };

  function defaultData() { return JSON.parse(JSON.stringify(DEFAULT_DATA)); }

  // ==================== API Layer ====================
  let _apiCache = {};
  function _loadCache() { try { const r = localStorage.getItem(CACHE_KEY); if (r) _apiCache = JSON.parse(r); } catch(e) { _apiCache = {}; } }
  function _saveCache() {
    const now = Date.now();
    for (const k of Object.keys(_apiCache)) { if (now - _apiCache[k].ts > CACHE_TTL * 2) delete _apiCache[k]; }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(_apiCache)); } catch(e) { _apiCache = {}; }
  }

  async function fetchOA(path, params) {
    const url = new URL(API_BASE + path);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    url.searchParams.set("mailto", "fsi-tracker@academic-tools.app");
    const cacheKey = url.toString();
    const cached = _apiCache[cacheKey];
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error("OpenAlex API " + resp.status);
    const data = await resp.json();
    _apiCache[cacheKey] = { ts: Date.now(), data };
    _saveCache();
    return data;
  }

  // ==================== Abstract Reconstruction ====================
  function reconstructAbstract(invertedIndex) {
    if (!invertedIndex || typeof invertedIndex !== "object") return "";
    const words = [];
    for (const [word, positions] of Object.entries(invertedIndex)) {
      for (const pos of positions) words[pos] = word;
    }
    return words.filter(w => w !== undefined).join(" ");
  }

  // ==================== Parse Article ====================
  function parseArticle(work) {
    const authors = (work.authorships || []).slice(0, 4).map(a => a.author?.display_name || "").filter(Boolean);
    if ((work.authorships || []).length > 4) authors.push("...");
    const doi = work.doi || "";
    const doiUrl = doi.startsWith("http") ? doi : (doi ? "https://doi.org/" + doi : "");
    let title = (work.title || "Untitled").replace(/<[^>]*>/g, "");
    return {
      title,
      authors: authors.join(", "),
      year: work.publication_year || "",
      doi: doiUrl,
      citations: work.cited_by_count || 0,
      oaId: work.id || "",
      abstract: reconstructAbstract(work.abstract_inverted_index),
      referencedWorks: (work.referenced_works || []).slice(0, 30),
      citedByUrl: work.cited_by_api_url || ""
    };
  }

  // ==================== AI Translation Layer ====================
  const TRANS_KEY = "fsi_tracker_translations";
  const TRANS_MAX = 500;

  function _getTranslateConfig() {
    return {
      provider: localStorage.getItem("fsi_w_translate_provider") || "openai",
      apiKey: localStorage.getItem("fsi_w_translate_key") || "",
      model: localStorage.getItem("fsi_w_translate_model") || "",
      endpoint: localStorage.getItem("fsi_w_translate_endpoint") || ""
    };
  }

  function _getDefaultEndpoint(provider) {
    switch (provider) {
      case "deepseek": return "https://api.deepseek.com";
      case "claude": return "https://api.anthropic.com";
      case "gemini": return "https://generativelanguage.googleapis.com";
      default: return "https://api.openai.com/v1";
    }
  }

  function _getDefaultModel(provider) {
    switch (provider) {
      case "deepseek": return "deepseek-chat";
      case "claude": return "claude-3-5-haiku-20241022";
      case "gemini": return "gemini-2.5-flash";
      default: return "gpt-4o-mini";
    }
  }

  async function _callAI(messages) {
    const cfg = _getTranslateConfig();
    if (!cfg.apiKey) throw new Error("NO_API_KEY");
    const endpoint = cfg.endpoint || _getDefaultEndpoint(cfg.provider);
    const model = cfg.model || _getDefaultModel(cfg.provider);

    if (cfg.provider === "claude") {
      const systemMsg = messages.find(m => m.role === "system");
      const userMsgs = messages.filter(m => m.role !== "system");
      const body = { model, max_tokens: 2048, messages: userMsgs };
      if (systemMsg) body.system = systemMsg.content;
      const resp = await fetch(endpoint + "/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error("API " + resp.status);
      const data = await resp.json();
      if (!data.content || !data.content[0]) throw new Error("API 返回格式异常");
      return data.content[0].text;
    } else if (cfg.provider === "gemini") {
      const systemMsg = messages.find(m => m.role === "system");
      const userMsg = messages.find(m => m.role === "user");
      const body = { contents: [{ parts: [{ text: userMsg.content }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 2048 } };
      if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
      const url = endpoint + "/v1beta/models/" + model + ":generateContent?key=" + cfg.apiKey;
      const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!resp.ok) throw new Error("API " + resp.status);
      const data = await resp.json();
      if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]) throw new Error("API 返回格式异常");
      return data.candidates[0].content.parts[0].text;
    } else {
      // OpenAI / DeepSeek compatible
      const url = endpoint.includes("/chat/completions") ? endpoint : (endpoint.endsWith("/v1") ? endpoint + "/chat/completions" : endpoint + "/v1/chat/completions");
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
        body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 2048 })
      });
      if (!resp.ok) throw new Error("API " + resp.status);
      const data = await resp.json();
      if (!data.choices || !data.choices[0]?.message) throw new Error("API 返回格式异常");
      return data.choices[0].message.content;
    }
  }

  // ==================== Translation Cache ====================
  function _getTransCache() { try { return JSON.parse(localStorage.getItem(TRANS_KEY) || "{}"); } catch(e) { return {}; } }
  function _saveTransCache(cache) {
    const keys = Object.keys(cache);
    if (keys.length > TRANS_MAX) {
      const sorted = keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
      const remove = sorted.slice(0, keys.length - TRANS_MAX);
      remove.forEach(k => delete cache[k]);
    }
    try { localStorage.setItem(TRANS_KEY, JSON.stringify(cache)); } catch(e) {}
  }

  // ==================== Modal Prompt/Confirm ====================
  let _promptResolve = null;
  function modalPrompt(title, placeholder, defaultVal) {
    return new Promise(resolve => {
      _promptResolve = resolve;
      document.getElementById("promptModalTitle").textContent = title;
      const input = document.getElementById("promptModalInput");
      const body = document.getElementById("promptModalBody");
      input.style.display = "block";
      input.placeholder = placeholder || "";
      input.value = defaultVal || "";
      document.getElementById("promptModalOk").textContent = "确认";
      document.getElementById("promptModalOverlay").classList.add("show");
      setTimeout(() => { input.focus(); input.select(); }, 100);
    });
  }
  function modalConfirm(title, message) {
    return new Promise(resolve => {
      _promptResolve = resolve;
      document.getElementById("promptModalTitle").textContent = title;
      const input = document.getElementById("promptModalInput");
      const body = document.getElementById("promptModalBody");
      input.style.display = "none";
      if (message) {
        body.innerHTML = '<div style="color:#e2e8f0;font-size:14px;padding:4px 0">' + esc(message) + '</div>';
        body.appendChild(input);
      }
      document.getElementById("promptModalOk").textContent = "确认";
      document.getElementById("promptModalOverlay").classList.add("show");
    });
  }

  // ==================== Core Tracker ====================
  const T = {
    data: defaultData(),
    _selectedJournal: null,
    _selectedScholar: null,
    _currentView: "tracking", // "tracking" | "topics"
    _citChainStack: [], // navigation stack for citation chain

    // === Prompt/Confirm helpers ===
    _resolvePrompt(val) {
      document.getElementById("promptModalOverlay").classList.remove("show");
      // Restore body to default state
      const body = document.getElementById("promptModalBody");
      const input = document.getElementById("promptModalInput");
      body.innerHTML = '';
      body.appendChild(input);
      input.style.display = "block";
      if (_promptResolve) { const r = _promptResolve; _promptResolve = null; r(val); }
    },
    _resolvePromptOk() {
      const input = document.getElementById("promptModalInput");
      const val = input.style.display === "none" ? true : input.value;
      this._resolvePrompt(val);
    },

    // === Persistence ===
    save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.assign({}, this.data, {_v: DATA_VERSION}))); } catch(e) {} },
    load() {
      _loadCache();
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const p = JSON.parse(raw);
          if (p._v && p._v >= DATA_VERSION && Array.isArray(p.journalGroups) && p.journalGroups.length > 0) {
            this.data = { journalGroups: p.journalGroups, scholarGroups: p.scholarGroups||[], keywordGroups: p.keywordGroups||[], lastRefresh: p.lastRefresh||null };
            return;
          }
          // Migrate from v10: add missing fields to articles
          if (p._v && p._v === 10 && Array.isArray(p.journalGroups)) {
            this.data = { journalGroups: p.journalGroups, scholarGroups: p.scholarGroups||[], keywordGroups: p.keywordGroups||[], lastRefresh: p.lastRefresh||null };
            // Add default fields to all existing articles
            this._migrateArticles();
            this.save();
            return;
          }
          // Migrate old flat format
          if (p._v && Array.isArray(p.journals) && p.journals.length > 0 && !Array.isArray(p.journalGroups)) {
            const dd = defaultData();
            const oldMap = {};
            p.journals.forEach(j => { oldMap[j.id] = j; });
            for (const g of dd.journalGroups) {
              for (const j of g.journals) {
                const old = oldMap[j.id];
                if (old && old.articles?.length > 0) j.articles = old.articles;
              }
            }
            if (Array.isArray(p.scholarGroups)) dd.scholarGroups = p.scholarGroups;
            if (Array.isArray(p.keywordGroups)) dd.keywordGroups = p.keywordGroups;
            dd.lastRefresh = p.lastRefresh || null;
            this.data = dd;
            this._migrateArticles();
            this.save();
            return;
          }
        }
      } catch(e) {}
      this.data = defaultData(); this.save();
    },

    _migrateArticles() {
      // Add default values for new fields to all existing articles
      const migrate = (a) => {
        if (!a.abstract) a.abstract = "";
        if (!a.referencedWorks) a.referencedWorks = [];
        if (!a.citedByUrl) a.citedByUrl = "";
      };
      for (const g of this.data.journalGroups) for (const j of g.journals) (j.articles||[]).forEach(migrate);
      for (const g of this.data.scholarGroups) for (const s of g.scholars) (s.articles||[]).forEach(migrate);
      for (const kw of this.data.keywordGroups) (kw.results||[]).forEach(migrate);
    },

    // === Helpers to find items ===
    _findJournal(jid) {
      for (const g of this.data.journalGroups) { const j = g.journals.find(x => x.id === jid); if (j) return { group: g, journal: j }; }
      return null;
    },
    _findScholar(sid) {
      for (const g of this.data.scholarGroups) { const s = g.scholars.find(x => x.id === sid); if (s) return { group: g, scholar: s }; }
      return null;
    },

    // ==================== NOTES & STATUS ====================
    _getNotes() { try { return JSON.parse(localStorage.getItem(NOTES_KEY) || "{}"); } catch(e) { return {}; } },
    _saveNotes(n) { localStorage.setItem(NOTES_KEY, JSON.stringify(n)); },
    getNote(doi) { if (!doi) return null; const n = this._getNotes(); return n[doi] || null; },
    setNote(doi, note) {
      if (!doi) return;
      const notes = this._getNotes();
      if (!notes[doi]) notes[doi] = { note: "", status: "" };
      notes[doi].note = note;
      this._saveNotes(notes);
      if (typeof debouncedPush === "function") debouncedPush("编辑论文笔记");
    },
    getStatus(doi) { if (!doi) return ""; const n = this._getNotes(); return n[doi]?.status || ""; },
    setStatus(doi, status) {
      if (!doi) return;
      const notes = this._getNotes();
      if (!notes[doi]) notes[doi] = { note: "", status: "" };
      notes[doi].status = status;
      this._saveNotes(notes);
      this.render();
      if (typeof debouncedPush === "function") debouncedPush("标记阅读状态");
    },
    cycleStatus(doi) {
      const order = ["", "toread", "read", "cited"];
      const cur = this.getStatus(doi);
      const next = order[(order.indexOf(cur) + 1) % order.length];
      this.setStatus(doi, next);
    },
    _statusIcon(status) {
      switch (status) {
        case "toread": return '<span class="status-dot toread" title="待读">📌</span>';
        case "read": return '<span class="status-dot read" title="已读">📖</span>';
        case "cited": return '<span class="status-dot cited" title="已引用">✅</span>';
        default: return '<span class="status-dot none" title="点击标记状态">○</span>';
      }
    },

    // ==================== TOPIC GROUPS ====================
    _getTopics() { try { return JSON.parse(localStorage.getItem(TOPICS_KEY) || "[]"); } catch(e) { return []; } },
    _saveTopics(t) {
      // Strip transient UI state (_collapsed) before persisting
      var clean = t.map(function(topic) {
        var o = Object.assign({}, topic);
        delete o._collapsed;
        return o;
      });
      localStorage.setItem(TOPICS_KEY, JSON.stringify(clean));
    },

    async addTopicGroup() {
      const name = await modalPrompt("新建综述分组", "分组名称（如：水射流冲击实验方法）");
      if (!name?.trim()) return;
      const topics = this._getTopics();
      topics.push({ id: uid(), name: name.trim(), papers: [] });
      this._saveTopics(topics);
      this.renderTopicGroups();
      if (typeof debouncedPush === "function") debouncedPush("新建综述分组");
    },
    async removeTopicGroup(tid) {
      const ok = await modalConfirm("删除分组", "确认删除该综述分组？");
      if (!ok) return;
      const topics = this._getTopics().filter(t => t.id !== tid);
      this._saveTopics(topics);
      this.renderTopicGroups();
      if (typeof debouncedPush === "function") debouncedPush("删除综述分组");
    },
    async renameTopicGroup(tid) {
      const topics = this._getTopics();
      const t = topics.find(x => x.id === tid); if (!t) return;
      const name = await modalPrompt("重命名分组", "分组名称", t.name);
      if (name?.trim()) { t.name = name.trim(); this._saveTopics(topics); this.renderTopicGroups(); if (typeof debouncedPush === "function") debouncedPush("重命名综述分组"); }
    },
    addPaperToTopic(articleJson, topicId) {
      const a = JSON.parse(decodeURIComponent(articleJson));
      const topics = this._getTopics();
      const t = topics.find(x => x.id === topicId); if (!t) return;
      if (t.papers.some(p => p.doi && p.doi === a.doi)) { showToast("已在该分组中"); return; }
      t.papers.push(a);
      this._saveTopics(topics);
      showToast("已加入: " + t.name);
      if (typeof debouncedPush === "function") debouncedPush("添加论文到分组");
    },
    removePaperFromTopic(topicId, doi) {
      const topics = this._getTopics();
      const t = topics.find(x => x.id === topicId); if (!t) return;
      t.papers = t.papers.filter(p => p.doi !== doi);
      this._saveTopics(topics);
      this.renderTopicGroups();
      if (typeof debouncedPush === "function") debouncedPush("移除分组论文");
    },

    showAddToTopicMenu(evt, articleJson) {
      // Remove existing menu
      const old = document.getElementById("topicMenu"); if (old) old.remove();
      const topics = this._getTopics();
      if (!topics.length) { showToast("请先在综述分组中创建分组"); return; }
      const menu = document.createElement("div");
      menu.id = "topicMenu";
      menu.className = "topic-add-menu";
      let html = '<div class="topic-menu-title">加入分组</div>';
      for (const t of topics) {
        html += '<div class="topic-menu-item" onclick="event.stopPropagation();Tracker.addPaperToTopic(\'' + articleJson + '\',\'' + t.id + '\');document.getElementById(\'topicMenu\').remove()">' + esc(t.name) + '</div>';
      }
      menu.innerHTML = html;
      document.body.appendChild(menu);
      // Position near cursor
      const rect = evt.target.getBoundingClientRect();
      menu.style.left = Math.min(rect.left, window.innerWidth - 200) + "px";
      menu.style.top = (rect.bottom + 4) + "px";
      // Close on outside click
      setTimeout(() => {
        document.addEventListener("click", function handler(e) {
          if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", handler); }
        });
      }, 50);
    },

    exportTopicsMd() {
      const topics = this._getTopics();
      if (!topics.length) { showToast("暂无分组"); return; }
      const notes = this._getNotes();
      let md = "# Literature Review Outline\n\n";
      md += "_Generated " + new Date().toLocaleDateString("en-US") + "_\n\n";
      for (const t of topics) {
        md += "## " + t.name + " (" + t.papers.length + " papers)\n\n";
        for (const p of t.papers) {
          md += "- **" + p.title + "** (" + p.authors.split(",")[0] + ", " + p.year + ")";
          if (p.doi) md += " [DOI](" + p.doi + ")";
          md += "\n";
          const n = notes[p.doi];
          if (n?.note) md += "  - _" + n.note + "_\n";
          if (n?.status) md += "  - Status: " + (n.status === "cited" ? "Cited" : n.status === "read" ? "Read" : "To Read") + "\n";
        }
        md += "\n";
      }
      navigator.clipboard.writeText(md)
        .then(() => showToast("综述大纲已复制到剪贴板"))
        .catch(() => {
          const blob = new Blob([md], {type: "text/markdown"});
          const url = URL.createObjectURL(blob);
          const dl = document.createElement("a"); dl.href = url; dl.download = "literature_review.md"; dl.click(); URL.revokeObjectURL(url);
          showToast("已下载 literature_review.md");
        });
    },

    // ==================== CITATION CHAIN ====================
    async showCitationChain(articleJson) {
      const a = JSON.parse(decodeURIComponent(articleJson));
      this._citChainStack = [a];
      this._citChainTab = "citedby";
      document.getElementById("citChainOverlay").classList.add("show");
      this._renderCitChain();
    },
    closeCitChain() {
      document.getElementById("citChainOverlay").classList.remove("show");
      this._citChainStack = [];
    },
    citChainBack() {
      if (this._citChainStack.length > 1) { this._citChainStack.pop(); this._renderCitChain(); }
    },
    switchCitTab(tab) {
      this._citChainTab = tab;
      this._renderCitChain();
    },
    citChainDrillDown(articleJson) {
      const a = JSON.parse(decodeURIComponent(articleJson));
      this._citChainStack.push(a);
      this._citChainTab = "citedby";
      this._renderCitChain();
    },

    async _renderCitChain() {
      const a = this._citChainStack[this._citChainStack.length - 1];
      const tab = this._citChainTab || "citedby";
      // Update header
      const titleEl = document.getElementById("citChainTitle");
      titleEl.textContent = a.title.length > 40 ? a.title.substring(0, 40) + "..." : a.title;
      document.getElementById("citChainBack").style.display = this._citChainStack.length > 1 ? "inline-flex" : "none";
      // Update tab buttons
      document.querySelectorAll("#citChainTabs .panel-btn").forEach(btn => {
        btn.classList.toggle("primary", btn.dataset.tab === tab);
      });
      // Load content
      const content = document.getElementById("citChainContent");
      content.innerHTML = '<div style="text-align:center;padding:30px"><span class="loading-spinner"></span> 加载中...</div>';

      try {
        let articles = [];
        // Resolve oaId if needed
        let oaId = a.oaId ? a.oaId.replace("https://openalex.org/", "") : "";
        let citedByUrl = a.citedByUrl || "";
        let refWorks = a.referencedWorks || [];

        // If missing citedByUrl/referencedWorks, fetch full work metadata first
        if (!citedByUrl && !refWorks.length && (a.doi || oaId)) {
          try {
            const lookupPath = oaId ? "/works/" + oaId : "/works/doi:" + a.doi.replace("https://doi.org/", "");
            const resp = await fetch(API_BASE + lookupPath + "?mailto=fsi-tracker@academic-tools.app");
            const work = await resp.json();
            if (work) {
              citedByUrl = work.cited_by_api_url || "";
              refWorks = (work.referenced_works || []).slice(0, 30);
              oaId = oaId || (work.id || "").replace("https://openalex.org/", "");
            }
          } catch(e2) { console.warn("citchain lookup fail", e2); }
        }

        if (tab === "citedby") {
          if (citedByUrl) {
            const url = new URL(citedByUrl);
            url.searchParams.set("per_page", "20");
            url.searchParams.set("sort", "cited_by_count:desc");
            url.searchParams.set("mailto", "fsi-tracker@academic-tools.app");
            const resp = await fetch(url.toString());
            const data = await resp.json();
            articles = (data.results || []).map(parseArticle);
          }
        } else {
          // references
          if (refWorks.length > 0) {
            const ids = refWorks.slice(0, 20).map(id => id.replace("https://openalex.org/", "")).join("|");
            const data = await fetchOA("/works", { filter: "openalex:" + ids, per_page: "20", sort: "cited_by_count:desc" });
            articles = (data.results || []).map(parseArticle);
          }
        }
        if (articles.length === 0) {
          content.innerHTML = '<div class="empty-state">暂无' + (tab === "citedby" ? "引用此文的论文" : "参考文献") + '</div>';
        } else {
          let html = '<div class="article-list">';
          for (const art of articles) html += this._renderArticle(art, true, "citchain");
          html += '</div>';
          content.innerHTML = html;
        }
      } catch(e) {
        content.innerHTML = '<div class="empty-state" style="color:#f87171">加载失败: ' + esc(e.message) + '</div>';
      }
    },

    // ==================== REFRESH ====================
    async refreshJournals() {
      for (const g of this.data.journalGroups) {
        for (const j of g.journals) {
          try {
            let oaId = j.openalex_id;
            if (!oaId) { const r = await fetchOA("/sources", {search: j.name, per_page:"1"}); if (r.results?.[0]) { oaId = r.results[0].id; j.openalex_id = oaId; j.url = j.url || r.results[0].homepage_url || ""; } }
            if (oaId) { const r = await fetchOA("/works", {filter:"primary_location.source.id:"+oaId, sort:"publication_date:desc", per_page:String(MAX_ARTICLES)}); j.articles = (r.results||[]).map(parseArticle); }
          } catch(e) { console.error("Journal refresh fail:", j.abbr, e); }
        }
      }
      this.data.lastRefresh = Date.now(); this.save(); this.render();
      showToast("期刊已刷新");
    },

    async refreshScholars() {
      for (const g of this.data.scholarGroups) {
        for (const s of g.scholars) {
          try {
            let oaId = s.openalex_id;
            if (!oaId) { const r = await fetchOA("/authors", {search: s.name, per_page:"1"}); if (r.results?.[0]) { oaId = r.results[0].id; s.openalex_id = oaId; s.url = s.url || r.results[0].id || ""; } }
            if (oaId) { const r = await fetchOA("/works", {filter:"authorships.author.id:"+oaId, sort:"publication_date:desc", per_page:String(MAX_ARTICLES)}); s.articles = (r.results||[]).map(parseArticle); }
          } catch(e) { console.error("Scholar refresh fail:", s.name, e); }
        }
      }
      this.data.lastRefresh = Date.now(); this.save(); this.render();
      showToast("学者已刷新");
    },

    async refreshDiscoveries() {
      const yr = new Date().getFullYear();
      for (const kw of this.data.keywordGroups) {
        try { const r = await fetchOA("/works", {search:kw.terms, filter:"publication_year:"+(yr-2)+"-"+yr+",type:article", sort:"cited_by_count:desc", per_page:String(MAX_ARTICLES)}); kw.results = (r.results||[]).map(parseArticle); } catch(e) {}
      }
      this.data.lastRefresh = Date.now(); this.save(); this.render();
      showToast("论文推荐已刷新");
    },

    async refreshAll() { showToast("正在刷新..."); await Promise.all([this.refreshJournals(), this.refreshScholars(), this.refreshDiscoveries()]); },

    // ==================== CRUD ====================
    // Journal Groups
    async addJournalGroup() {
      const name = await modalPrompt("新建期刊分组", "分组名称");
      if (!name?.trim()) return;
      this.data.journalGroups.push({id: uid(), name: name.trim(), journals: []});
      this.save(); this.renderJournalPanel();
    },
    async removeJournalGroup(gid) {
      const ok = await modalConfirm("删除分组", "确认删除该分组及其所有期刊？");
      if (!ok) return;
      this.data.journalGroups = this.data.journalGroups.filter(g => g.id !== gid);
      this.save(); this.renderJournalPanel();
    },
    async renameJournalGroup(gid) {
      const g = this.data.journalGroups.find(x => x.id === gid); if (!g) return;
      const name = await modalPrompt("重命名分组", "分组名称", g.name);
      if (name?.trim()) { g.name = name.trim(); this.save(); this.renderJournalPanel(); }
    },
    removeJournal(jid) {
      for (const g of this.data.journalGroups) g.journals = g.journals.filter(j => j.id !== jid);
      if (this._selectedJournal?.journalId === jid) this._selectedJournal = null;
      this.save(); this.renderJournalPanel();
    },

    // Scholar Groups
    async addScholarGroup() {
      const el = document.getElementById("groupNameInput");
      const name = el ? (el.value||"").trim() : (await modalPrompt("新建分组", "分组名称", ""));
      if (!name?.trim()) return;
      this.data.scholarGroups.push({id: uid(), name, scholars: []});
      this.save(); this.renderScholarPanel(); this.closeGroupModal();
    },
    async removeScholarGroup(gid) {
      const ok = await modalConfirm("删除分组", "确认删除该学者分组？");
      if (!ok) return;
      this.data.scholarGroups = this.data.scholarGroups.filter(g => g.id !== gid);
      this.save(); this.renderScholarPanel();
    },
    async renameScholarGroup(gid) {
      const g = this.data.scholarGroups.find(x => x.id === gid); if (!g) return;
      const name = await modalPrompt("重命名分组", "分组名称", g.name);
      if (name?.trim()) { g.name = name.trim(); this.save(); this.renderScholarPanel(); }
    },
    removeScholar(sid) {
      for (const g of this.data.scholarGroups) g.scholars = g.scholars.filter(s => s.id !== sid);
      if (this._selectedScholar?.scholarId === sid) this._selectedScholar = null;
      this.save(); this.renderScholarPanel();
    },

    // Keywords
    addKeywordGroup() {
      const label = (document.getElementById("kwLabelInput")?.value||"").trim();
      const terms = (document.getElementById("kwTermsInput")?.value||"").trim();
      if (!label || !terms) { showToast("请填写标签和关键词"); return; }
      this.data.keywordGroups.push({id: uid(), label, terms, results: []});
      this.save(); this.renderDiscoveryPanel(); this.closeKeywordModal();
      this.refreshDiscoveries();
    },
    removeKeywordGroup(id) {
      this.data.keywordGroups = this.data.keywordGroups.filter(k => k.id !== id);
      this.save(); this.renderDiscoveryPanel();
    },

    // ==================== RENDERING ====================
    render() {
      this.renderJournalPanel();
      this.renderScholarPanel();
      this.renderDiscoveryPanel();
      if (this._currentView === "topics") this.renderTopicGroups();
      if (this.data.lastRefresh) {
        const txt = "上次刷新: " + formatTime(this.data.lastRefresh);
        ["journalRefreshTime","scholarRefreshTime","discoveryRefreshTime"].forEach(id => {
          const el = document.getElementById(id); if (el) el.textContent = txt;
        });
      }
    },

    switchView(view) {
      this._currentView = view;
      const trackingEl = document.getElementById("trackingView");
      const topicsEl = document.getElementById("topicsView");
      const searchEl = document.getElementById("searchView");
      if (trackingEl) trackingEl.style.display = view === "tracking" ? "flex" : "none";
      if (topicsEl) topicsEl.style.display = view === "topics" ? "block" : "none";
      if (searchEl) searchEl.style.display = view === "search" ? "block" : "none";
      document.querySelectorAll(".view-tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
      if (view === "topics") this.renderTopicGroups();
      if (view === "search") this._renderSearchJournalFilters();
    },

    renderJournalPanel() {
      const body = document.getElementById("journalBody"); if (!body) return;
      let html = "";
      for (const g of this.data.journalGroups) {
        html += '<div class="chip-group">' +
          '<div class="chip-group-header">' +
            '<span class="chip-group-name">' + esc(g.name) + '</span>' +
            '<button class="mini-btn" onclick="Tracker.renameJournalGroup(\'' + g.id + '\')" title="重命名">✏️</button>' +
            '<button class="mini-btn danger" onclick="Tracker.removeJournalGroup(\'' + g.id + '\')" title="删除分组">✕</button>' +
          '</div>' +
          '<div class="chip-row">';
        for (const j of g.journals) {
          const sel = this._selectedJournal?.journalId === j.id;
          const count = j.articles?.length || 0;
          html += '<div class="chip' + (sel ? ' active' : '') + '" onclick="Tracker.selectJournal(\'' + g.id + '\',\'' + j.id + '\')">' +
            '<span class="chip-label">' + esc(j.abbr || j.name) + '</span>' +
            (count > 0 ? '<span class="chip-count">' + count + '</span>' : '') +
            '</div>';
        }
        html += '</div></div>';
      }
      if (this._selectedJournal) {
        const f = this._findJournal(this._selectedJournal.journalId);
        if (f) {
          const j = f.journal;
          html += '<div class="detail-area">' +
            '<div class="detail-header">' +
              '<span class="detail-title">' + esc(j.abbr || j.name) + ' — ' + esc(j.name) + '</span>' +
              '<div class="detail-actions">' +
                (j.url ? '<a href="' + esc(j.url) + '" target="_blank" class="mini-btn" title="打开主页">🔗</a>' : '') +
                '<button class="mini-btn" onclick="Tracker.exportBibTeX(\'journal\',\'' + j.id + '\')" title="导出 BibTeX">📚</button>' +
                '<button class="mini-btn" onclick="Tracker.showJournalInfo(\'' + j.id + '\')" title="期刊信息/分区">ℹ️</button>' +
                '<button class="mini-btn" onclick="Tracker.showEditModal(\'journal\',\'' + j.id + '\')" title="编辑">✏️</button>' +
                '<button class="mini-btn danger" onclick="Tracker.removeJournal(\'' + j.id + '\')" title="删除">🗑️</button>' +
              '</div>' +
            '</div>';
          if (j.articles?.length > 0) {
            html += '<div class="article-list">';
            for (const a of j.articles) html += this._renderArticle(a, false, "default");
            html += '</div>';
          } else {
            html += '<div class="empty-state" style="padding:10px">暂无文章，点击 🔄 刷新</div>';
          }
          html += '</div>';
        }
      }
      body.innerHTML = html || '<div class="empty-state">暂无期刊</div>';
    },

    renderScholarPanel() {
      const body = document.getElementById("scholarBody"); if (!body) return;
      let html = "";
      for (const g of this.data.scholarGroups) {
        html += '<div class="chip-group">' +
          '<div class="chip-group-header">' +
            '<span class="chip-group-name">' + esc(g.name) + '</span>' +
            '<span class="chip-group-badge">' + g.scholars.length + '人</span>' +
            '<button class="mini-btn" onclick="Tracker.renameScholarGroup(\'' + g.id + '\')" title="重命名">✏️</button>' +
            '<button class="mini-btn danger" onclick="Tracker.removeScholarGroup(\'' + g.id + '\')" title="删除">✕</button>' +
          '</div>' +
          '<div class="chip-row">';
        for (const s of g.scholars) {
          const sel = this._selectedScholar?.scholarId === s.id;
          const count = s.articles?.length || 0;
          html += '<div class="chip' + (sel ? ' active' : '') + '" onclick="Tracker.selectScholar(\'' + g.id + '\',\'' + s.id + '\')">' +
            '<span class="chip-label">' + esc(s.name) + '</span>' +
            (count > 0 ? '<span class="chip-count">' + count + '</span>' : '') +
            '</div>';
        }
        if (g.scholars.length === 0) html += '<span style="font-size:12px;color:#475569">暂无学者</span>';
        html += '</div></div>';
      }
      if (this._selectedScholar) {
        const f = this._findScholar(this._selectedScholar.scholarId);
        if (f) {
          const s = f.scholar;
          html += '<div class="detail-area">' +
            '<div class="detail-header">' +
              '<span class="detail-title">' + esc(s.name) + '</span>' +
              '<div class="detail-actions">' +
                (s.url ? '<a href="' + esc(s.url) + '" target="_blank" class="mini-btn" title="打开主页">🔗</a>' : '') +
                '<button class="mini-btn" onclick="Tracker.exportBibTeX(\'scholar\',\'' + s.id + '\')" title="导出 BibTeX">📚</button>' +
                '<button class="mini-btn" onclick="Tracker.showEditModal(\'scholar\',\'' + s.id + '\')" title="编辑">✏️</button>' +
                '<button class="mini-btn danger" onclick="Tracker.removeScholar(\'' + s.id + '\')" title="删除">🗑️</button>' +
              '</div>' +
            '</div>';
          if (s.articles?.length > 0) {
            html += '<div class="article-list">';
            for (const a of s.articles) html += this._renderArticle(a, false, "default");
            html += '</div>';
          } else {
            html += '<div class="empty-state" style="padding:10px">暂无文章，点击 🔄 刷新</div>';
          }
          html += '</div>';
        }
      }
      body.innerHTML = html || '<div class="empty-state">暂无学者</div>';
    },

    renderDiscoveryPanel() {
      const body = document.getElementById("discoveryBody"); if (!body) return;
      if (this.data.keywordGroups.length === 0) { body.innerHTML = '<div class="empty-state">暂无关键词</div>'; return; }
      const seenDois = new Set();
      let html = "";
      for (const kw of this.data.keywordGroups) {
        const unique = (kw.results || []).filter(a => {
          if (!a.doi) return true;
          if (seenDois.has(a.doi)) return false;
          seenDois.add(a.doi);
          return true;
        });
        const has = unique.length > 0;
        const dupCount = (kw.results?.length || 0) - unique.length;
        html += '<div class="keyword-group' + (has ? ' open' : '') + '">' +
          '<div class="keyword-header" onclick="this.parentElement.classList.toggle(\'open\')">' +
            '<span class="card-arrow">▶</span>' +
            '<span class="keyword-tag">' + esc(kw.label) + '</span>' +
            '<span class="keyword-terms">' + esc(kw.terms) + '</span>' +
            (dupCount > 0 ? '<span style="font-size:12px;color:#475569;margin-left:4px" title="与前面的关键词组重复">(-' + dupCount + ')</span>' : '') +
            '<button class="mini-btn" onclick="event.stopPropagation();Tracker.exportBibTeX(\'keyword\',\'' + kw.id + '\')" title="导出 BibTeX" style="margin-left:auto">📚</button>' +
            '<button class="mini-btn" onclick="event.stopPropagation();Tracker.editKeywordGroup(\'' + kw.id + '\')" title="编辑">✏️</button>' +
            '<button class="mini-btn danger" onclick="event.stopPropagation();Tracker.removeKeywordGroup(\'' + kw.id + '\')" title="删除">✕</button>' +
          '</div>' +
          '<div class="keyword-body">';
        if (has) { html += '<div class="article-list">'; for (const a of unique) html += this._renderArticle(a, true, "default"); html += '</div>'; }
        else { html += '<div class="empty-state" style="padding:10px">点击 🔄 刷新</div>'; }
        html += '</div></div>';
      }
      body.innerHTML = html;
    },

    // ==================== TOPIC GROUPS VIEW ====================
    renderTopicGroups() {
      const body = document.getElementById("topicsBody"); if (!body) return;
      const topics = this._getTopics();
      const notes = this._getNotes();
      if (!topics.length) {
        body.innerHTML = '<div class="empty-state" style="padding:40px">暂无综述分组<br><span style="font-size:13px;color:#475569;margin-top:8px;display:inline-block">点击上方「➕ 新建分组」创建你的第一个文献综述分组<br>然后在追踪面板中把论文加入分组</span></div>';
        return;
      }
      let html = '';
      for (const t of topics) {
        const isOpen = !t._collapsed;
        html += '<div class="topic-card">' +
          '<div class="topic-card-header" onclick="Tracker._toggleTopicCard(\'' + t.id + '\')">' +
            '<span class="card-arrow">' + (isOpen ? '▼' : '▶') + '</span>' +
            '<span class="topic-card-name">' + esc(t.name) + '</span>' +
            '<span class="topic-card-count">' + t.papers.length + '篇</span>' +
            '<button class="mini-btn" onclick="event.stopPropagation();Tracker.renameTopicGroup(\'' + t.id + '\')" title="重命名">✏️</button>' +
            '<button class="mini-btn danger" onclick="event.stopPropagation();Tracker.removeTopicGroup(\'' + t.id + '\')" title="删除">🗑️</button>' +
          '</div>';
        if (isOpen) {
          html += '<div class="topic-card-body">';
          if (t.papers.length === 0) {
            html += '<div style="padding:12px;color:#475569;font-size:13px;text-align:center">在追踪面板中点击论文的 📂 按钮添加到此分组</div>';
          } else {
            for (const p of t.papers) {
              const n = notes[p.doi];
              const status = n?.status || "";
              const click = p.doi ? ' onclick="window.open(\'' + esc(p.doi) + '\',\'_blank\')"' : '';
              html += '<div class="topic-paper">' +
                '<div class="topic-paper-top">' +
                  '<span class="status-click" onclick="event.stopPropagation();Tracker.cycleStatus(\'' + esc(p.doi) + '\')">' + this._statusIcon(status) + '</span>' +
                  '<div class="topic-paper-info">' +
                    '<div class="article-title"' + click + '>' + esc(p.title) + '</div>' +
                    '<div class="article-meta">' + esc(p.authors) + (p.year ? ' · ' + p.year : '') + (p.citations > 0 ? ' · 🔥' + p.citations : '') + '</div>' +
                  '</div>' +
                  '<button class="mini-btn danger" onclick="event.stopPropagation();Tracker.removePaperFromTopic(\'' + t.id + '\',\'' + esc(p.doi) + '\')" title="移出分组" style="flex-shrink:0">✕</button>' +
                '</div>';
              if (n?.note) {
                html += '<div class="topic-paper-note">📝 ' + esc(n.note) + '</div>';
              }
              html += '</div>';
            }
          }
          html += '</div>';
        }
        html += '</div>';
      }
      body.innerHTML = html;
    },

    _toggleTopicCard(tid) {
      const topics = this._getTopics();
      const t = topics.find(x => x.id === tid);
      if (t) { t._collapsed = !t._collapsed; this._saveTopics(topics); this.renderTopicGroups(); }
    },

    // ==================== ARTICLE RENDERING ====================
    _renderArticle(a, showCitations, context) {
      context = context || "default";
      const aJson = encodeURIComponent(JSON.stringify(a)).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
      const click = a.doi ? ' onclick="window.open(\'' + esc(a.doi) + '\',\'_blank\')"' : '';
      const starred = a.doi && this.isBookmarked(a.doi);
      const status = this.getStatus(a.doi);
      const noteObj = this.getNote(a.doi);
      let meta = esc(a.authors); if (a.year) meta += ' · ' + a.year;
      if (showCitations && a.citations > 0) meta += ' <span class="article-citations">🔥 ' + a.citations + '</span>';

      let h = '<div class="article-item">';
      // Top row: status + star + title
      h += '<div class="article-top">';
      if (a.doi) h += '<span class="status-click" onclick="event.stopPropagation();Tracker.cycleStatus(\'' + esc(a.doi) + '\')">' + this._statusIcon(status) + '</span>';
      if (a.doi) h += '<span class="mini-btn bookmark-star" onclick="event.stopPropagation();Tracker.toggleBookmark(\'' + aJson + '\')" title="' + (starred ? '取消收藏' : '收藏') + '" style="color:' + (starred ? '#f59e0b' : '#475569') + '">' + (starred ? '★' : '☆') + '</span>';
      const transCache = _getTransCache();
      const doi = a.doi || a.oaId;
      const trans = doi ? transCache[doi] : null;
      h += '<div class="article-main"><div class="article-title"' + click + '>' + esc(a.title) + '</div>';
      h += '<div class="article-title-zh"' + (trans ? '' : ' style="display:none"') + '>' + (trans ? esc(trans.title) : '') + '</div>';
      h += '<div class="article-meta">' + meta + '</div></div></div>';

      // Action buttons row
      h += '<div class="article-actions">';
      if (a.doi || a.oaId) h += '<button class="action-btn" onclick="event.stopPropagation();Tracker._toggleAbstract(this,\'' + aJson + '\')">📋 摘要</button>';
      if (a.doi || a.oaId) {
        h += '<button class="action-btn" onclick="event.stopPropagation();Tracker.' + (context === "citchain" ? 'citChainDrillDown' : 'showCitationChain') + '(\'' + aJson + '\')">🔗 引用链</button>';
      }
      if (a.doi) h += '<button class="action-btn" onclick="event.stopPropagation();Tracker._showNoteInput(\'' + esc(a.doi) + '\',this)">📝 笔记</button>';
      if (context !== "topic") h += '<button class="action-btn" onclick="event.stopPropagation();Tracker.showAddToTopicMenu(event,\'' + aJson + '\')">📂 分组</button>';
      if (doi) h += '<button class="action-btn" onclick="event.stopPropagation();Tracker._translateArticle(this,\'' + aJson + '\')">' + (trans ? '🀄 翻译✓' : '🀄 翻译') + '</button>';
      h += '<button class="action-btn" onclick="event.stopPropagation();Tracker._sendToReader(\'' + aJson + '\')">📖 导入阅读器</button>';
      h += '</div>';

      // Abstract (collapsed, may be loaded on demand)
      h += '<div class="article-abstract">' + (a.abstract ? esc(a.abstract) : '') + '<div class="article-abstract-zh"' + (trans && trans.abstract ? '' : ' style="display:none"') + '>' + (trans && trans.abstract ? esc(trans.abstract) : '') + '</div></div>';

      // Note preview
      if (noteObj?.note) {
        h += '<div class="article-note-preview">📝 ' + esc(noteObj.note) + '</div>';
      }

      h += '</div>';
      return h;
    },

    // Toggle abstract — fetch from OpenAlex if not cached
    async _toggleAbstract(btnEl, articleJson) {
      const absDiv = btnEl.closest('.article-item').querySelector('.article-abstract');
      if (absDiv.classList.contains('show')) { absDiv.classList.remove('show'); return; }
      if (absDiv.textContent.trim()) { absDiv.classList.add('show'); return; }
      // Need to fetch from OpenAlex
      const a = JSON.parse(decodeURIComponent(articleJson));
      absDiv.innerHTML = '<span class="loading-spinner"></span> 加载摘要...';
      absDiv.classList.add('show');
      try {
        const oaId = a.oaId ? a.oaId.replace('https://openalex.org/', '') : '';
        let work = null;
        if (oaId) {
          const resp = await fetch(API_BASE + '/works/' + oaId + '?mailto=fsi-tracker@academic-tools.app');
          work = await resp.json();
        } else if (a.doi) {
          const resp = await fetch(API_BASE + '/works/doi:' + a.doi.replace('https://doi.org/', '') + '?mailto=fsi-tracker@academic-tools.app');
          work = await resp.json();
        }
        if (work && work.abstract_inverted_index) {
          const text = reconstructAbstract(work.abstract_inverted_index);
          // Preserve the .article-abstract-zh child element
          const zhChild = absDiv.querySelector('.article-abstract-zh');
          absDiv.textContent = text;
          if (zhChild) absDiv.appendChild(zhChild);
        } else {
          const zhChild = absDiv.querySelector('.article-abstract-zh');
          absDiv.innerHTML = '<span style="color:#64748b">该文章暂无摘要数据</span>';
          if (zhChild) absDiv.appendChild(zhChild);
        }
      } catch(e) {
        absDiv.innerHTML = '<span style="color:#f87171">加载失败</span>';
      }
    },

    // Translate article title + abstract to Chinese
    async _translateArticle(btnEl, articleJson) {
      const a = JSON.parse(decodeURIComponent(articleJson));
      const item = btnEl.closest('.article-item');
      const titleZhEl = item.querySelector('.article-title-zh');
      const absZhEl = item.querySelector('.article-abstract-zh');

      // Toggle off if already showing
      if (titleZhEl && titleZhEl.textContent.trim() && titleZhEl.style.display !== 'none') {
        titleZhEl.style.display = 'none';
        if (absZhEl) absZhEl.style.display = 'none';
        btnEl.textContent = '🀄 翻译';
        return;
      }

      // Check cache
      const doi = a.doi || a.oaId;
      if (!doi) { showToast("无法翻译：缺少文章标识"); return; }
      const cache = _getTransCache();
      if (cache[doi]) {
        if (titleZhEl) { titleZhEl.textContent = cache[doi].title; titleZhEl.style.display = 'block'; }
        if (absZhEl && cache[doi].abstract) { absZhEl.textContent = cache[doi].abstract; absZhEl.style.display = 'block'; }
        btnEl.textContent = '🀄 翻译✓';
        return;
      }

      // Need to call API
      btnEl.textContent = '⏳ 翻译中...';
      btnEl.disabled = true;

      try {
        // Get abstract if not available
        let abstractText = a.abstract || '';
        if (!abstractText && (a.oaId || a.doi)) {
          try {
            const oaId = a.oaId ? a.oaId.replace('https://openalex.org/', '') : '';
            const lookupPath = oaId ? '/works/' + oaId : '/works/doi:' + a.doi.replace('https://doi.org/', '');
            const resp = await fetch(API_BASE + lookupPath + '?mailto=fsi-tracker@academic-tools.app');
            const work = await resp.json();
            if (work && work.abstract_inverted_index) {
              abstractText = reconstructAbstract(work.abstract_inverted_index);
              // Also update the abstract display
              const absDiv = item.querySelector('.article-abstract');
              if (absDiv && !absDiv.textContent.trim()) absDiv.textContent = abstractText;
            }
          } catch(e) { /* ignore, translate title only */ }
        }

        let userContent = 'Title: ' + a.title;
        if (abstractText) userContent += '\n\nAbstract: ' + abstractText;

        const result = await _callAI([
          { role: "system", content: "你是学术论文翻译助手。请将以下英文学术论文标题" + (abstractText ? "和摘要" : "") + "翻译成中文。保留专业术语的准确性，翻译简洁通顺。\n\n输出格式：\n===TITLE===\n（标题中文翻译）" + (abstractText ? "\n===ABSTRACT===\n（摘要中文翻译）" : "") },
          { role: "user", content: userContent }
        ]);

        // Parse result
        const titleMatch = result.match(/===TITLE===\s*([\s\S]*?)(?:===ABSTRACT===|$)/);
        const absMatch = result.match(/===ABSTRACT===\s*([\s\S]*?)$/);
        const titleZh = titleMatch ? titleMatch[1].trim() : result.trim();
        const absZh = absMatch ? absMatch[1].trim() : '';

        // Save to cache
        cache[doi] = { title: titleZh, abstract: absZh, ts: Date.now() };
        _saveTransCache(cache);

        // Display
        if (titleZhEl) { titleZhEl.textContent = titleZh; titleZhEl.style.display = 'block'; }
        if (absZhEl && absZh) { absZhEl.textContent = absZh; absZhEl.style.display = 'block'; }
        btnEl.textContent = '🀄 翻译✓';
      } catch(e) {
        if (e.message === "NO_API_KEY") {
          showToast("请先在写作助手页面配置翻译 API Key（⚙ 按钮）");
        } else {
          showToast("翻译失败: " + e.message);
        }
        btnEl.textContent = '🀄 翻译';
      } finally {
        btnEl.disabled = false;
      }
    },

    _showNoteInput(doi, btnEl) {
      // Toggle existing
      const existing = btnEl.closest('.article-item').querySelector('.note-input-area');
      if (existing) { existing.remove(); return; }
      const noteObj = this.getNote(doi);
      const div = document.createElement("div");
      div.className = "note-input-area";
      div.innerHTML = '<input class="search-input" placeholder="写一句话笔记..." value="' + esc(noteObj?.note || '') + '" style="font-size:13px;padding:6px 10px">' +
        '<button class="panel-btn primary" style="font-size:12px;padding:4px 10px;margin-left:6px" onclick="Tracker.setNote(\'' + esc(doi) + '\',this.previousElementSibling.value);this.parentElement.remove();Tracker.render()">保存</button>';
      div.querySelector("input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { this.setNote(doi, e.target.value); div.remove(); this.render(); }
      });
      btnEl.closest('.article-item').appendChild(div);
      div.querySelector("input").focus();
    },

    // ==================== EDIT / SELECT / MODALS ====================
    selectJournal(gid, jid) {
      if (this._selectedJournal?.journalId === jid) { this._selectedJournal = null; }
      else { this._selectedJournal = {groupId: gid, journalId: jid}; }
      this.renderJournalPanel();
    },
    selectScholar(gid, sid) {
      if (this._selectedScholar?.scholarId === sid) { this._selectedScholar = null; }
      else { this._selectedScholar = {groupId: gid, scholarId: sid}; }
      this.renderScholarPanel();
    },

    showEditModal(type, id) {
      let item, fields;
      if (type === "journal") {
        const f = this._findJournal(id); if (!f) return; item = f.journal;
        fields = [
          {key:"name", label:"期刊全名", val: item.name},
          {key:"abbr", label:"缩写", val: item.abbr || ""},
          {key:"url", label:"主页链接", val: item.url || ""},
          {key:"openalex_id", label:"OpenAlex ID", val: item.openalex_id || ""},
        ];
      } else if (type === "scholar") {
        const f = this._findScholar(id); if (!f) return; item = f.scholar;
        fields = [
          {key:"name", label:"学者姓名", val: item.name},
          {key:"url", label:"主页链接 (Google Scholar等)", val: item.url || ""},
          {key:"openalex_id", label:"OpenAlex ID", val: item.openalex_id || ""},
        ];
      } else return;
      const body = document.getElementById("editFields");
      body.innerHTML = fields.map(f =>
        '<div style="margin-bottom:10px"><label style="font-size:13px;color:#94a3b8;display:block;margin-bottom:4px">' + esc(f.label) + '</label>' +
        '<input class="search-input" data-key="' + f.key + '" value="' + esc(f.val) + '" style="width:100%;box-sizing:border-box"></div>'
      ).join("");
      document.getElementById("editModalOverlay").dataset.type = type;
      document.getElementById("editModalOverlay").dataset.id = id;
      document.getElementById("editModalTitle").textContent = type === "journal" ? "编辑期刊" : "编辑学者";
      document.getElementById("editModalOverlay").classList.add("show");
    },
    closeEditModal() { document.getElementById("editModalOverlay").classList.remove("show"); },

    async showJournalInfo(jid) {
      const f = this._findJournal(jid); if (!f) return;
      const j = f.journal;
      const infoEl = document.getElementById("journalInfoContent");
      const overlay = document.getElementById("journalInfoOverlay");
      document.getElementById("journalInfoTitle").textContent = j.name;
      infoEl.innerHTML = '<div style="text-align:center;padding:20px"><span class="loading-spinner"></span> 加载中...</div>';
      overlay.classList.add("show");
      try {
        const oaId = j.openalex_id;
        if (!oaId) { infoEl.innerHTML = '<div style="padding:16px;color:#64748b">无 OpenAlex ID，无法查询</div>'; return; }
        const shortId = oaId.replace("https://openalex.org/", "");
        const data = await fetchOA("/" + shortId, {});
        const stats = data.summary_stats || {};
        const IF2yr = stats["2yr_mean_citedness"] ? stats["2yr_mean_citedness"].toFixed(2) : "N/A";
        const hIdx = stats.h_index || "N/A";
        const i10 = stats.i10_index || "N/A";
        const worksCount = data.works_count ? data.works_count.toLocaleString() : "N/A";
        const citedBy = data.cited_by_count ? data.cited_by_count.toLocaleString() : "N/A";
        const isOA = data.is_oa ? "是" : "否";
        const type = data.type || "N/A";
        const issn = (data.issn || []).join(", ") || "N/A";
        const country = data.country_code || "N/A";
        infoEl.innerHTML =
          '<table class="info-table">' +
          '<tr><td>类型</td><td>' + esc(type) + '</td></tr>' +
          '<tr><td>ISSN</td><td>' + esc(issn) + '</td></tr>' +
          '<tr><td>国家</td><td>' + esc(country) + '</td></tr>' +
          '<tr><td>总发文量</td><td>' + worksCount + '</td></tr>' +
          '<tr><td>总被引次数</td><td>' + citedBy + '</td></tr>' +
          '<tr><td>2年平均被引 (≈IF)</td><td><b style="color:#38bdf8">' + IF2yr + '</b></td></tr>' +
          '<tr><td>h-index</td><td><b style="color:#4ade80">' + hIdx + '</b></td></tr>' +
          '<tr><td>i10-index</td><td>' + i10 + '</td></tr>' +
          '<tr><td>开放获取</td><td>' + isOA + '</td></tr>' +
          '</table>' +
          '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #334155">' +
            '<div style="font-size:13px;color:#94a3b8;margin-bottom:6px">查询 SCI / 中科院分区:</div>' +
            '<a href="https://www.letpub.com.cn/index.php?journalid=' + encodeURIComponent(j.name) + '&page=journalapp&view=search" target="_blank" class="info-link">📊 LetPub 查分区</a>' +
            '<a href="https://jcr.clarivate.com/jcr/browse-journals?search=' + encodeURIComponent(j.name) + '" target="_blank" class="info-link">📈 JCR 官方查询</a>' +
            '<a href="https://www.scimagojr.com/journalsearch.php?q=' + encodeURIComponent(j.name) + '" target="_blank" class="info-link">🏆 SCImago 排名</a>' +
          '</div>';
      } catch(e) {
        infoEl.innerHTML = '<div style="padding:16px;color:#f87171">查询失败: ' + esc(e.message) + '</div>';
      }
    },
    closeJournalInfo() { document.getElementById("journalInfoOverlay").classList.remove("show"); },

    // ==================== SEARCH MODALS ====================
    _searchType: null, _searchDebounce: null,

    showAddJournal() {
      this._searchType = "journal";
      const groups = this.data.journalGroups;
      if (groups.length === 0) { showToast("请先创建一个期刊分组"); return; }
      document.getElementById("searchModalTitle").textContent = "搜索期刊";
      document.getElementById("searchInput").placeholder = "输入期刊名称 (英文)...";
      const wrap = document.getElementById("groupSelectWrap");
      const sel = document.getElementById("groupSelect");
      sel.innerHTML = groups.map(g => '<option value="'+g.id+'">'+esc(g.name)+'</option>').join("");
      wrap.style.display = "block";
      document.getElementById("searchInput").value = "";
      document.getElementById("searchResults").innerHTML = '<div class="search-empty">输入关键词开始搜索</div>';
      document.getElementById("searchModalOverlay").classList.add("show");
      setTimeout(() => document.getElementById("searchInput").focus(), 100);
      this._bindSearchInput();
    },

    showAddScholar() {
      this._searchType = "scholar";
      const groups = this.data.scholarGroups;
      if (groups.length === 0) { showToast("请先创建一个学者分组"); return; }
      document.getElementById("searchModalTitle").textContent = "搜索学者";
      document.getElementById("searchInput").placeholder = "输入学者姓名 (英文)...";
      const wrap = document.getElementById("groupSelectWrap");
      const sel = document.getElementById("groupSelect");
      sel.innerHTML = groups.map(g => '<option value="'+g.id+'">'+esc(g.name)+'</option>').join("");
      wrap.style.display = "block";
      document.getElementById("searchInput").value = "";
      document.getElementById("searchResults").innerHTML = '<div class="search-empty">输入关键词开始搜索</div>';
      document.getElementById("searchModalOverlay").classList.add("show");
      setTimeout(() => document.getElementById("searchInput").focus(), 100);
      this._bindSearchInput();
    },

    closeSearchModal() { document.getElementById("searchModalOverlay").classList.remove("show"); this._searchType = null; },
    showAddKeyword() {
      document.getElementById("kwLabelInput").value = ""; document.getElementById("kwTermsInput").value = "";
      document.getElementById("keywordModalOverlay").classList.add("show");
      setTimeout(() => document.getElementById("kwLabelInput").focus(), 100);
    },
    closeKeywordModal() { document.getElementById("keywordModalOverlay").classList.remove("show"); },
    showAddGroup() {
      document.getElementById("groupNameInput").value = "";
      document.getElementById("groupModalOverlay").classList.add("show");
      setTimeout(() => document.getElementById("groupNameInput").focus(), 100);
    },
    closeGroupModal() { document.getElementById("groupModalOverlay").classList.remove("show"); },

    _bindSearchInput() {
      const input = document.getElementById("searchInput");
      const ni = input.cloneNode(true); input.parentNode.replaceChild(ni, input);
      ni.addEventListener("input", () => { clearTimeout(this._searchDebounce); this._searchDebounce = setTimeout(() => this._doSearch(ni.value.trim()), DEBOUNCE_MS); });
      ni.addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(this._searchDebounce); this._doSearch(ni.value.trim()); } });
    },

    async _doSearch(q) {
      const r = document.getElementById("searchResults");
      if (!q) { r.innerHTML = '<div class="search-empty">输入关键词开始搜索</div>'; return; }
      r.innerHTML = '<div class="search-loading"><span class="loading-spinner"></span> 搜索中...</div>';
      try {
        if (this._searchType === "journal") { const d = await fetchOA("/sources", {search:q, per_page:"8"}); this._renderJournalResults(d.results||[]); }
        else if (this._searchType === "scholar") { const d = await fetchOA("/authors", {search:q, per_page:"8"}); this._renderScholarResults(d.results||[]); }
      } catch(e) { r.innerHTML = '<div class="search-empty">搜索失败: '+esc(e.message)+'</div>'; }
    },

    _renderJournalResults(sources) {
      const r = document.getElementById("searchResults");
      if (!sources.length) { r.innerHTML = '<div class="search-empty">未找到</div>'; return; }
      const existing = new Set();
      this.data.journalGroups.forEach(g => g.journals.forEach(j => { if (j.openalex_id) existing.add(j.openalex_id); }));
      r.innerHTML = sources.map(s => {
        const id = s.id||"", already = existing.has(id), works = s.works_count?s.works_count.toLocaleString():"0";
        const safeName = (s.display_name||"").replace(/'/g, "\\'").replace(/"/g, "&quot;");
        const safeUrl = (s.homepage_url||"").replace(/'/g, "\\'").replace(/"/g, "&quot;");
        return '<div class="search-result-item"><div class="search-result-info">' +
          '<div class="search-result-name">'+esc(s.display_name||"")+'</div>' +
          '<div class="search-result-detail">ISSN: '+esc((s.issn||[]).join(", ")||"N/A")+' · '+works+' works</div></div>' +
          (already ? '<span style="font-size:13px;color:#4ade80">已添加</span>' :
          '<button class="search-result-add" onclick="Tracker._addJournalFromSearch(\''+esc(id)+'\',\''+safeName+'\',\''+safeUrl+'\')">添加</button>') + '</div>';
      }).join("");
    },

    _addJournalFromSearch(oaId, name, url) {
      const gid = document.getElementById("groupSelect").value;
      const g = this.data.journalGroups.find(x => x.id === gid);
      if (!g) { showToast("请选择分组"); return; }
      const abbr = name.split(/\s+/).filter(w => w.length > 2 || w[0] === w[0].toUpperCase()).map(w => w[0].toUpperCase()).join("");
      g.journals.push({id: uid(), name, abbr: abbr || name.substring(0,6), openalex_id: oaId, url, articles: []});
      this.save(); this.render(); this.closeSearchModal();
      showToast("已添加: " + name); this.refreshJournals();
    },

    _renderScholarResults(authors) {
      const r = document.getElementById("searchResults");
      if (!authors.length) { r.innerHTML = '<div class="search-empty">未找到</div>'; return; }
      const existing = new Set();
      this.data.scholarGroups.forEach(g => g.scholars.forEach(s => { if (s.openalex_id) existing.add(s.openalex_id); }));
      r.innerHTML = authors.map(a => {
        const id = a.id||"", already = existing.has(id);
        const inst = (a.last_known_institutions||[]).map(i=>i.display_name).join(", ")||"";
        const works = a.works_count?a.works_count.toLocaleString():"0", cited = a.cited_by_count?a.cited_by_count.toLocaleString():"0";
        const safeName = (a.display_name||"").replace(/'/g, "\\'").replace(/"/g, "&quot;");
        return '<div class="search-result-item"><div class="search-result-info">' +
          '<div class="search-result-name">'+esc(a.display_name||"")+'</div>' +
          '<div class="search-result-detail">'+esc(inst)+' · '+works+' works · '+cited+' cited</div></div>' +
          (already ? '<span style="font-size:13px;color:#4ade80">已添加</span>' :
          '<button class="search-result-add" onclick="Tracker._addScholarFromSearch(\''+esc(id)+'\',\''+safeName+'\')">添加</button>') + '</div>';
      }).join("");
    },

    _addScholarFromSearch(oaId, name) {
      const gid = document.getElementById("groupSelect").value;
      const g = this.data.scholarGroups.find(x => x.id === gid);
      if (!g) { showToast("请选择分组"); return; }
      g.scholars.push({id: uid(), name, openalex_id: oaId, url: oaId, articles: []});
      this.save(); this.render(); this.closeSearchModal();
      showToast("已添加: " + name + " → " + g.name); this.refreshScholars();
    },

    // === BibTeX Export ===
    exportBibTeX(type, id) {
      let articles = [], label = "";
      if (type === "journal") { const f = this._findJournal(id); if (!f) return; articles = f.journal.articles || []; label = f.journal.abbr || f.journal.name; }
      else if (type === "scholar") { const f = this._findScholar(id); if (!f) return; articles = f.scholar.articles || []; label = f.scholar.name; }
      else if (type === "keyword") { const kw = this.data.keywordGroups.find(k => k.id === id); if (!kw) return; articles = kw.results || []; label = kw.label; }
      else if (type === "bookmarks") { articles = this._getBookmarks(); label = "bookmarks"; }
      if (!articles.length) { showToast("没有文章可导出"); return; }
      const bib = articles.map((a, i) => {
        const key = (a.authors.split(",")[0] || "unknown").trim().replace(/\s+/g, "_").toLowerCase() + (a.year || "") + "_" + (i + 1);
        const doi = a.doi ? a.doi.replace("https://doi.org/", "") : "";
        return "@article{" + key + ",\n  title = {" + a.title + "},\n  author = {" + a.authors + "},\n  year = {" + (a.year || "") + "},\n" + (doi ? "  doi = {" + doi + "},\n" : "") + "}";
      }).join("\n\n");
      navigator.clipboard.writeText(bib).then(() => showToast("已复制 " + articles.length + " 篇 BibTeX")).catch(() => {
        const blob = new Blob([bib], {type: "text/plain"}); const url = URL.createObjectURL(blob);
        const dl = document.createElement("a"); dl.href = url; dl.download = label.replace(/\s+/g, "_") + ".bib"; dl.click(); URL.revokeObjectURL(url);
      });
    },

    // === Bookmarks ===
    _bookmarksKey: "fsi_tracker_bookmarks",
    _getBookmarks() { try { return JSON.parse(localStorage.getItem(this._bookmarksKey) || "[]"); } catch(e) { return []; } },
    _saveBookmarks(bm) { localStorage.setItem(this._bookmarksKey, JSON.stringify(bm)); },
    isBookmarked(doi) { if (!doi) return false; return this._getBookmarks().some(b => b.doi === doi); },
    toggleBookmark(articleJson) {
      const a = JSON.parse(decodeURIComponent(articleJson));
      let bm = this._getBookmarks();
      const idx = bm.findIndex(b => b.doi === a.doi);
      if (idx >= 0) { bm.splice(idx, 1); showToast("已取消收藏"); }
      else { bm.unshift(a); showToast("已收藏: " + (a.title.length > 30 ? a.title.substring(0, 30) + "..." : a.title)); }
      this._saveBookmarks(bm); this.render();
    },

    showBookmarks() {
      const bm = this._getBookmarks();
      const overlay = document.getElementById("bookmarksOverlay");
      const content = document.getElementById("bookmarksContent");
      document.getElementById("bookmarksCount").textContent = bm.length + " 篇";
      if (!bm.length) {
        content.innerHTML = '<div class="empty-state">暂无收藏文章<br><span style="font-size:12px;color:#475569">点击文章旁的 ☆ 可收藏</span></div>';
      } else {
        let html = '<div style="display:flex;gap:6px;margin-bottom:10px">' +
          '<button class="panel-btn primary" onclick="Tracker.exportBibTeX(\'bookmarks\',\'\')" style="font-size:13px">📚 导出全部 BibTeX</button>' +
          '<button class="panel-btn" onclick="Tracker._confirmClearBookmarks()" style="font-size:13px">🗑️ 清空</button></div>';
        html += '<div class="article-list">';
        for (const a of bm) html += this._renderArticle(a, true, "bookmark");
        html += '</div>';
        content.innerHTML = html;
      }
      overlay.classList.add("show");
    },
    closeBookmarks() { document.getElementById("bookmarksOverlay").classList.remove("show"); },
    async _confirmClearBookmarks() {
      this.closeBookmarks();
      const ok = await modalConfirm("清空收藏", "确认清空所有收藏文章？");
      if (!ok) { this.showBookmarks(); return; }
      this._saveBookmarks([]); this.render(); this.showBookmarks();
    },
    _clearBookmarks() { this._saveBookmarks([]); this.render(); this.showBookmarks(); },

    // === Edit Keyword Group ===
    editKeywordGroup(id) {
      const kw = this.data.keywordGroups.find(k => k.id === id); if (!kw) return;
      const body = document.getElementById("editFields");
      body.innerHTML =
        '<div style="margin-bottom:10px"><label style="font-size:13px;color:#94a3b8;display:block;margin-bottom:4px">标签名称</label>' +
        '<input class="search-input" data-key="label" value="' + esc(kw.label) + '" style="width:100%;box-sizing:border-box"></div>' +
        '<div style="margin-bottom:10px"><label style="font-size:13px;color:#94a3b8;display:block;margin-bottom:4px">搜索关键词（英文）</label>' +
        '<input class="search-input" data-key="terms" value="' + esc(kw.terms) + '" style="width:100%;box-sizing:border-box"></div>';
      document.getElementById("editModalOverlay").dataset.type = "keyword";
      document.getElementById("editModalOverlay").dataset.id = id;
      document.getElementById("editModalTitle").textContent = "编辑关键词组";
      document.getElementById("editModalOverlay").classList.add("show");
    },

    saveEdit() {
      const overlay = document.getElementById("editModalOverlay");
      const type = overlay.dataset.type, id = overlay.dataset.id;
      if (type === "keyword") {
        const kw = this.data.keywordGroups.find(k => k.id === id);
        if (kw) {
          document.querySelectorAll("#editFields input[data-key]").forEach(inp => { kw[inp.dataset.key] = inp.value.trim(); });
          this.save(); this.renderDiscoveryPanel(); this.closeEditModal(); showToast("已保存"); this.refreshDiscoveries();
        }
        return;
      }
      let item;
      if (type === "journal") { const f = this._findJournal(id); item = f?.journal; }
      else if (type === "scholar") { const f = this._findScholar(id); item = f?.scholar; }
      if (!item) return;
      document.querySelectorAll("#editFields input[data-key]").forEach(inp => { item[inp.dataset.key] = inp.value.trim(); });
      this.save();
      if (type === "journal") this.renderJournalPanel();
      else if (type === "scholar") this.renderScholarPanel();
      this.closeEditModal(); showToast("已保存");
    },

    // ==================== 导入到阅读器 ====================
    _sendToReader(articleJson) {
      const a = JSON.parse(decodeURIComponent(articleJson));
      const READER_KEY = "fsi_papers_data";
      let papers = [];
      try { papers = JSON.parse(localStorage.getItem(READER_KEY) || "[]"); } catch(e) {}

      // 检查是否已存在（按 DOI 或标题去重）
      const titleNorm = (a.title || "").toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 40);
      const exists = papers.some(p => {
        if (a.doi && p.doi && p.doi === a.doi) return true;
        const pNorm = (p.title || "").toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 40);
        return titleNorm && pNorm && titleNorm === pNorm;
      });
      if (exists) {
        showToast("📖 已在阅读器中");
        return;
      }

      // 创建阅读器格式的论文对象
      const paper = {
        id: "paper_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
        title: a.title || "",
        authors: a.authors || "",
        year: a.year || null,
        journal: a.journal || "",
        doi: a.doi || "",
        tags: [],
        summary: a.abstract || "",
        sections: [],
        notes: [],
        hasPdf: false,
        addedAt: Date.now(),
        updatedAt: Date.now()
      };
      papers.unshift(paper);
      localStorage.setItem(READER_KEY, JSON.stringify(papers));

      // 跨页面同步：直接推送 papers 数据到 Gist
      if (typeof isGHConnected === "function" && isGHConnected()) {
        const PAPERS_GIST = "fsi_papers_sync.json";
        let crCache = {};
        try { crCache = JSON.parse(localStorage.getItem("fsi_cr_cache") || "{}"); } catch(e) {}
        let folders = [];
        try { folders = JSON.parse(localStorage.getItem("fsi_folders_data") || "[]"); } catch(e) {}
        const papersContent = JSON.stringify({ papers, folders, closeReading: crCache, ts: Date.now() });
        // 异步推送，不阻塞 UI
        ghAPI("https://api.github.com/gists/" + getGHGistId(), {
          method: "PATCH",
          body: JSON.stringify({ files: { [PAPERS_GIST]: { content: papersContent } } })
        }).catch(e => console.warn("[tracker] push papers to gist failed:", e));
      }

      const shortTitle = a.title.length > 25 ? a.title.slice(0, 25) + "..." : a.title;
      showToast("📖 已导入阅读器: " + shortTitle);
    },

    // ==================== 文献检索 ====================
    _searchJournalSelected: null, // Set of selected openalex_ids, null = all

    _renderSearchJournalFilters() {
      const container = document.getElementById("litSearchJournalFilter");
      if (!container) return;
      // Collect all tracked journals
      const journals = [];
      for (const g of this.data.journalGroups) {
        for (const j of g.journals) {
          if (j.openalex_id) journals.push({ name: j.abbr || j.name, oaId: j.openalex_id });
        }
      }
      if (!journals.length) {
        container.innerHTML = '<span style="font-size:12px;color:#64748b">暂无追踪期刊</span>';
        return;
      }
      // Init selected set: default all selected
      if (!this._searchJournalSelected) {
        this._searchJournalSelected = new Set(journals.map(j => j.oaId));
      }
      let html = '<span style="font-size:12px;color:#94a3b8;margin-right:4px">期刊范围：</span>';
      // "All" toggle
      const allSelected = this._searchJournalSelected.size === journals.length;
      html += '<span class="chip' + (allSelected ? ' active' : '') + '" style="font-size:11px;padding:2px 8px;cursor:pointer" onclick="Tracker._toggleSearchJournalAll()">' +
        '全部' + '</span>';
      for (const j of journals) {
        const sel = this._searchJournalSelected.has(j.oaId);
        html += '<span class="chip' + (sel ? ' active' : '') + '" style="font-size:11px;padding:2px 8px;cursor:pointer" onclick="Tracker._toggleSearchJournal(\'' + esc(j.oaId) + '\')">' +
          esc(j.name) + '</span>';
      }
      container.innerHTML = html;
    },

    _toggleSearchJournal(oaId) {
      if (!this._searchJournalSelected) this._searchJournalSelected = new Set();
      if (this._searchJournalSelected.has(oaId)) {
        this._searchJournalSelected.delete(oaId);
      } else {
        this._searchJournalSelected.add(oaId);
      }
      this._renderSearchJournalFilters();
    },

    _toggleSearchJournalAll() {
      const journals = [];
      for (const g of this.data.journalGroups) {
        for (const j of g.journals) {
          if (j.openalex_id) journals.push(j.openalex_id);
        }
      }
      const allSelected = this._searchJournalSelected && this._searchJournalSelected.size === journals.length;
      if (allSelected) {
        this._searchJournalSelected = new Set();
      } else {
        this._searchJournalSelected = new Set(journals);
      }
      this._renderSearchJournalFilters();
    },

    async doLitSearch() {
      const input = document.getElementById("litSearchInput");
      const resultsEl = document.getElementById("litSearchResults");
      if (!input || !resultsEl) return;
      const query = input.value.trim();
      if (!query) { showToast("请输入搜索关键词"); return; }

      // Get selected journals
      const selectedIds = this._searchJournalSelected ? [...this._searchJournalSelected] : [];
      if (selectedIds.length === 0) { showToast("请至少选择一个期刊"); return; }

      // Build source filter: source.id:S1|S2|S3
      const sourceIds = selectedIds.map(id => id.replace("https://openalex.org/", "")).join("|");

      // Year filter
      const yearVal = parseInt(document.getElementById("litSearchYear")?.value || "5");
      const sort = document.getElementById("litSearchSort")?.value || "relevance_score:desc";
      const count = parseInt(document.getElementById("litSearchCount")?.value || "25");

      let filter = "primary_location.source.id:" + sourceIds;
      if (yearVal > 0) {
        const fromYear = new Date().getFullYear() - yearVal;
        filter += ",publication_year:>" + fromYear;
      }

      resultsEl.innerHTML = '<div style="text-align:center;padding:40px"><span class="loading-spinner"></span> 搜索中...</div>';

      try {
        const data = await fetchOA("/works", {
          search: query,
          filter: filter,
          sort: sort,
          per_page: String(count)
        });

        const results = (data.results || []).map(w => parseArticle(w));
        const total = data.meta?.count || 0;

        if (!results.length) {
          resultsEl.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b">未找到相关文献</div>';
          return;
        }

        let html = '<div style="font-size:12px;color:#64748b;margin-bottom:8px">找到约 ' + total + ' 篇，显示前 ' + results.length + ' 篇</div>';
        html += '<div class="article-list">';
        for (const a of results) {
          html += this._renderArticle(a, true, "default");
        }
        html += '</div>';
        resultsEl.innerHTML = html;
      } catch(e) {
        console.error("[litSearch]", e);
        resultsEl.innerHTML = '<div style="text-align:center;padding:40px;color:#f87171">搜索失败: ' + esc(e.message) + '</div>';
      }
    },
  };

  window.Tracker = T;
})();
