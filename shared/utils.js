/* ==================== FSI 学术工具 - 共享工具函数 ==================== */

/** HTML 转义 */
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** 生成唯一 ID */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 格式化时间戳 */
function formatTime(ts) {
  return ts ? new Date(ts).toLocaleString("zh-CN") : "";
}

/** 显示 Toast 通知 */
function showToast(msg, duration) {
  duration = duration || 2500;
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), duration);
}

/** 显示弹窗 */
function showModal(id) {
  document.getElementById(id).classList.add("show");
}

/** 关闭弹窗 */
function closeModal(id) {
  document.getElementById(id).classList.remove("show");
}

/** 关闭所有弹窗 */
function closeAllModals() {
  document.querySelectorAll(".modal-overlay").forEach(el => el.classList.remove("show"));
}

/** 初始化弹窗：点击遮罩层关闭
 *  只有 mousedown 和 mouseup 都落在遮罩层本身时才关闭，
 *  防止输入框内拖选文字释放到外面时误关弹窗。 */
function setupModalOverlayClose() {
  document.querySelectorAll(".modal-overlay").forEach(el => {
    var pressStartedOnOverlay = false;
    el.addEventListener("mousedown", e => {
      pressStartedOnOverlay = (e.target === el);
    });
    el.addEventListener("mouseup", e => {
      var shouldClose = pressStartedOnOverlay && e.target === el;
      pressStartedOnOverlay = false;
      if (shouldClose) el.classList.remove("show");
    });
  });
}

/**
 * 渲染导航标签
 * @param {string} activePage - 当前页面 ID ("vocab" | "reader" | ...)
 * 添加新页面时，只需在 pages 数组里加一行
 */
function renderNavTabs(activePage) {
  const pages = [
    { id: "vocab",  href: "index.html",  emoji: "\u{1F4DA}", label: "\u8BCD\u5E93" },
    { id: "reader", href: "reader.html", emoji: "\u{1F4C4}", label: "\u8BBA\u6587" },
    { id: "writing", href: "writing.html", emoji: "✍️", label: "\u5199\u4F5C" },
    { id: "tracker", href: "tracker.html", emoji: "\u{1F52C}", label: "\u8FFD\u8E2A" },
    // ==NAV_PAGES== 未来新页面在此添加
  ];
  const container = document.getElementById("navTabs");
  if (!container) return;
  container.innerHTML = pages.map(p =>
    '<a class="nav-tab' + (p.id === activePage ? ' active' : '') + '" href="' + p.href + '">' +
    p.emoji + ' ' + p.label + '</a>'
  ).join("");
}

// ==================== 自动版本检查 ====================
// 每5分钟检查 version.json，如果版本号变了就提示刷新
(function autoVersionCheck() {
  var VERSION_URL = "version.json";
  var CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
  var _knownVersion = null;

  async function checkVersion() {
    try {
      var resp = await fetch(VERSION_URL + "?_=" + Date.now(), { cache: "no-store" });
      if (!resp.ok) return;
      var data = await resp.json();
      if (!_knownVersion) {
        _knownVersion = data.v;
        return;
      }
      if (data.v !== _knownVersion) {
        // Version changed — show update banner
        _knownVersion = data.v;
        _showUpdateBanner();
      }
    } catch(e) { /* ignore fetch errors */ }
  }

  function _showUpdateBanner() {
    if (document.getElementById("update-banner")) return;
    var banner = document.createElement("div");
    banner.id = "update-banner";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#e67e22;color:#fff;text-align:center;padding:10px 16px;font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    banner.innerHTML = "🔄 检测到新版本，点击刷新页面加载最新内容";
    banner.onclick = function() { location.reload(); };
    document.body.appendChild(banner);
  }

  // First check after 3s, then every 5 min
  setTimeout(checkVersion, 3000);
  setInterval(checkVersion, CHECK_INTERVAL);
})();
