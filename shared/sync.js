/* ==================== FSI 学术工具 - GitHub Gist 同步引擎 ==================== */
/* v3.7 — 实时自动同步（15s 轮询 + visibilitychange 优化） */

// ==================== 共享常量 ====================
const GH_TOKEN_KEY = "fsi_gh_token";
const GH_GIST_KEY = "fsi_gh_gist_id";

// ==================== Token / Gist ID 管理 ====================
function getGHToken() { return localStorage.getItem(GH_TOKEN_KEY) || ""; }
function getGHGistId() { return localStorage.getItem(GH_GIST_KEY) || ""; }
function isGHConnected() { return !!(getGHToken() && getGHGistId()); }

// ==================== GitHub API 请求 ====================
async function ghAPI(url, options) {
  options = options || {};
  const token = getGHToken();
  if (!token) throw new Error("未设置 GitHub Token");
  const headers = {
    "Authorization": "token " + token,
    "Accept": "application/vnd.github.v3+json"
  };
  if (options.body) headers["Content-Type"] = "application/json";
  const r = await fetch(url, { ...options, headers, cache: "no-store" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error("Token 无效或已过期，请重新设置");
    if (r.status === 404) throw new Error("Gist 不存在，请检查 ID");
    throw new Error("GitHub API " + r.status + ": " + (err.message || r.statusText));
  }
  // DELETE returns 204 No Content — no JSON body
  if (r.status === 204) return null;
  return r.json();
}

// ==================== 设备标识 ====================
const DEVICE_NAME_KEY = "fsi_device_name";
function getDeviceName() {
  let name = localStorage.getItem(DEVICE_NAME_KEY);
  if (name) return name;
  // 自动从 UA 生成
  const ua = navigator.userAgent;
  let os = "设备";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Macintosh/.test(ua)) os = "Mac";
  else if (/Linux/.test(ua) && !/Android/.test(ua)) os = "Linux";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  let browser = "";
  if (/Edg/.test(ua)) browser = "Edge";
  else if (/Chrome/.test(ua)) browser = "Chrome";
  else if (/Firefox/.test(ua)) browser = "Firefox";
  else if (/Safari/.test(ua)) browser = "Safari";
  name = os + (browser ? " " + browser : "");
  localStorage.setItem(DEVICE_NAME_KEY, name);
  return name;
}
function setDeviceName(name) {
  name = (name || "").trim();
  if (name) localStorage.setItem(DEVICE_NAME_KEY, name);
}

// ==================== 同步日志 + 设备心跳 ====================
const SYNC_LOG_FILE = "fsi_sync_log.json";
let _syncLogEntries = []; // { device, time, apps, page, desc }
let _deviceHeartbeats = {}; // { deviceName: { lastSeen: ISO, page: string } }
const _appDisplayNames = {
  vocab: "词库", papers: "论文", tracker: "追踪",
  writing: "写作", outline: "大纲", transdict: "翻译词库"
};
const HEARTBEAT_ONLINE_THRESHOLD = 45000; // 45秒内有心跳视为在线

function _appendSyncLogEntry(appIds, changeDesc) {
  if (!Array.isArray(appIds)) appIds = [appIds];
  const names = appIds.map(id => _appDisplayNames[id] || id);
  _syncLogEntries.unshift({
    device: getDeviceName(),
    time: new Date().toISOString(),
    apps: names,
    page: _getCurrentPage(),
    desc: changeDesc || null
  });
  if (_syncLogEntries.length > 20) _syncLogEntries.length = 20;
}

function _getCurrentPage() {
  const pageMap = { "index.html": "词库", "reader.html": "论文", "writing.html": "写作", "tracker.html": "追踪" };
  const path = location.pathname.split("/").pop() || "index.html";
  return pageMap[path] || path;
}

function _updateMyHeartbeat() {
  _deviceHeartbeats[getDeviceName()] = {
    lastSeen: new Date().toISOString(),
    page: _getCurrentPage()
  };
}

function _getSyncLogFileContent() {
  _updateMyHeartbeat();
  return JSON.stringify({ entries: _syncLogEntries, heartbeats: _deviceHeartbeats });
}

function _readHeartbeatsFromGist(gist) {
  if (!gist.files[SYNC_LOG_FILE]) return;
  try {
    const logData = JSON.parse(gist.files[SYNC_LOG_FILE].content);
    if (logData.entries) _syncLogEntries = logData.entries;
    if (logData.heartbeats) _deviceHeartbeats = logData.heartbeats;
  } catch (e) {}
}

function isDeviceOnline(deviceName) {
  const hb = _deviceHeartbeats[deviceName];
  if (!hb) return false;
  return (Date.now() - new Date(hb.lastSeen).getTime()) < HEARTBEAT_ONLINE_THRESHOLD;
}

function getDeviceList() {
  return Object.entries(_deviceHeartbeats).map(([name, hb]) => ({
    name,
    lastSeen: hb.lastSeen,
    page: hb.page,
    online: isDeviceOnline(name),
    isMe: name === getDeviceName()
  })).sort((a, b) => {
    // 本机优先，然后在线优先，然后按时间倒序
    if (a.isMe) return -1; if (b.isMe) return 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return new Date(b.lastSeen) - new Date(a.lastSeen);
  });
}

// ==================== 应用注册系统 ====================
const _syncApps = {};
let _currentAppId = null;

function registerSyncApp(config) {
  _syncApps[config.id] = config;
  if (!_currentAppId) _currentAppId = config.id;
}

function getCurrentSyncApp() {
  return _syncApps[_currentAppId] || null;
}

// ==================== Push / Pull ====================
async function ghPushApp(appId, skipLog, changeDesc) {
  const app = _syncApps[appId];
  if (!app) throw new Error("未注册的应用: " + appId);
  const gistId = getGHGistId();
  if (!gistId) throw new Error("未连接 Gist");
  const content = JSON.stringify(app.getLocalData());
  const files = { [app.gistFile]: { content } };
  // 附带同步日志（除非 skipLog）
  if (!skipLog) {
    _appendSyncLogEntry(appId, changeDesc);
    files[SYNC_LOG_FILE] = { content: _getSyncLogFileContent() };
  }
  const result = await ghAPI("https://api.github.com/gists/" + gistId, {
    method: "PATCH",
    body: JSON.stringify({ files })
  });
  localStorage.setItem(app.syncTsKey, Date.now().toString());
  return result;
}

async function ghPullApp(appId) {
  const app = _syncApps[appId];
  if (!app) throw new Error("未注册的应用: " + appId);
  const gistId = getGHGistId();
  if (!gistId) throw new Error("未连接 Gist");
  const gist = await ghAPI("https://api.github.com/gists/" + gistId);
  // 顺便读取同步日志 + 心跳
  _readHeartbeatsFromGist(gist);
  const file = gist.files[app.gistFile];
  if (!file) return null;
  return JSON.parse(file.content);
}

// ==================== 完整同步（用于首次连接） ====================
async function fullSyncForApp(appId, silent) {
  if (!isGHConnected()) return;
  const app = _syncApps[appId];
  if (!app) return;
  try {
    const remote = await ghPullApp(appId);
    if (remote) {
      app.applyRemoteData(remote);
    }
    // 只在本地数据与远端不同时才推送，避免无变化也产生同步日志
    const localData = app.getLocalData();
    const needPush = !remote || JSON.stringify(localData) !== JSON.stringify(remote);
    if (needPush) {
      await ghPushApp(appId);
    }
    if (app.onSyncComplete) app.onSyncComplete();
    if (!silent) syncLog(needPush ? "✅ 同步完成！" : "✅ 数据一致，无需同步");
  } catch (e) {
    if (!silent) syncLog("❌ 同步失败: " + e.message);
    throw e;
  }
}

// ==================== 实时轮询引擎 ====================
let _pollTimer = null;
let _lastKnownUpdatedAt = null;  // Gist 的 updated_at（ISO string）
let _isSyncing = false;          // 互斥锁
let _lastSyncTime = 0;          // 上次成功同步的时间戳
let _syncStatus = "idle";        // idle | syncing | synced | error | offline

async function ghPollAndApply() {
  if (_isSyncing || !isGHConnected()) return;
  _isSyncing = true;
  _syncStatus = "syncing";
  renderSyncStatus();

  try {
    const gistId = getGHGistId();
    const gist = await ghAPI("https://api.github.com/gists/" + gistId);

    // 每次 poll 都读取心跳（不管有没有变化）
    _readHeartbeatsFromGist(gist);

    // 首次轮询：记录 updated_at，不 apply（initSync 已做过首次同步）
    if (!_lastKnownUpdatedAt) {
      _lastKnownUpdatedAt = gist.updated_at;
      _syncStatus = "synced";
      _lastSyncTime = Date.now();
      renderSyncStatus();
      return;
    }

    // 无变化
    if (gist.updated_at === _lastKnownUpdatedAt) {
      _syncStatus = "synced";
      _lastSyncTime = Date.now();
      renderSyncStatus();
      return;
    }

    // 有变化 → 更新日志缓存 + 逐 app 比对
    _lastKnownUpdatedAt = gist.updated_at;
    // 读取远端同步日志 + 心跳
    _readHeartbeatsFromGist(gist);
    let anyChanged = false;

    for (const [appId, app] of Object.entries(_syncApps)) {
      const file = gist.files[app.gistFile];
      if (!file) continue;
      try {
        const remoteData = JSON.parse(file.content);
        const localData = app.getLocalData();
        // 简单比对：序列化后比较
        if (JSON.stringify(remoteData) !== JSON.stringify(localData)) {
          app.applyRemoteData(remoteData);
          if (app.onSyncComplete) app.onSyncComplete();
          anyChanged = true;
        }
      } catch (e) {
        console.warn("[sync] apply error for " + appId + ":", e);
      }
    }

    _syncStatus = "synced";
    _lastSyncTime = Date.now();
    if (anyChanged) {
      showToast("☁ 已同步远端更新");
    }
  } catch (e) {
    console.warn("[sync] poll error:", e);
    _syncStatus = "error";
  } finally {
    _isSyncing = false;
    renderSyncStatus();
  }
}

let _heartbeatTimer = null;

function startPolling() {
  if (_pollTimer || !isGHConnected()) return;
  ghPollAndApply();
  _pollTimer = setInterval(ghPollAndApply, 15000);
  // 心跳：每 30s 推一次轻量心跳（仅更新 log 文件中的 heartbeat）
  _pushHeartbeat(); // 立即发一次
  if (!_heartbeatTimer) {
    _heartbeatTimer = setInterval(_pushHeartbeat, 30000);
  }
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

async function _pushHeartbeat() {
  if (!isGHConnected() || _isSyncing) return;
  try {
    const gistId = getGHGistId();
    const content = _getSyncLogFileContent(); // 会自动更新本机心跳
    const result = await ghAPI("https://api.github.com/gists/" + gistId, {
      method: "PATCH",
      body: JSON.stringify({ files: { [SYNC_LOG_FILE]: { content } } })
    });
    // 更新 updated_at，避免下次 poll 把心跳推送当成数据变更
    if (result && result.updated_at) {
      _lastKnownUpdatedAt = result.updated_at;
    }
  } catch (e) {
    console.warn("[sync] heartbeat push failed:", e);
  }
}

// visibilitychange 优化：标签页隐藏时停止轮询 + flush 任何挂起的 push
document.addEventListener("visibilitychange", () => {
  if (!isGHConnected()) return;
  if (document.hidden) {
    stopPolling();
    // 兜底：如果有 pending 的 debouncedPush，立即 flush（避免切走后 3s 窗口没发出）
    if (_pushTimer) {
      console.log("[sync] visibility hidden — flushing pending push");
      clearTimeout(_pushTimer);
      _pushTimer = null;
      _doPushNow(null).catch(() => {});
    }
  } else {
    startPolling();
  }
});

// 关闭页面前 flush 任何挂起的 push（best-effort — 浏览器可能中断请求）
window.addEventListener("beforeunload", () => {
  if (!isGHConnected() || !_pushTimer) return;
  console.log("[sync] beforeunload — flushing pending push (best-effort)");
  clearTimeout(_pushTimer);
  _pushTimer = null;
  // Fire-and-forget；无法 await（beforeunload 不等 Promise）
  _doPushNow(null).catch(() => {});
});

// ==================== 连接 / 断开 ====================
async function ghConnect(tokenInputId, gistIdInputId, errorElId, connectBtnId) {
  const btn = document.getElementById(connectBtnId);
  const errEl = document.getElementById(errorElId);
  const token = document.getElementById(tokenInputId).value.trim();
  const gistIdEl = document.getElementById(gistIdInputId);
  const gistId = gistIdEl ? gistIdEl.value.trim() : "";

  if (!token) { errEl.textContent = "请输入 Token"; errEl.style.display = "block"; return; }
  if (!token.startsWith("ghp_") && !token.startsWith("github_pat_")) {
    errEl.textContent = "Token 格式不对，应以 ghp_ 或 github_pat_ 开头";
    errEl.style.display = "block"; return;
  }

  btn.textContent = "连接中..."; btn.disabled = true;
  errEl.style.display = "none";

  try {
    localStorage.setItem(GH_TOKEN_KEY, token);

    if (gistId) {
      localStorage.setItem(GH_GIST_KEY, gistId);
      await ghAPI("https://api.github.com/gists/" + gistId);
    } else {
      const app = getCurrentSyncApp();
      const content = JSON.stringify(app ? app.getLocalData() : {});
      const desc = app ? app.createGistDescription : "FSI Sync";
      const gist = await ghAPI("https://api.github.com/gists", {
        method: "POST",
        body: JSON.stringify({
          description: desc, public: false,
          files: { [app ? app.gistFile : "fsi_sync.json"]: { content } }
        })
      });
      localStorage.setItem(GH_GIST_KEY, gist.id);
    }

    // 对所有已注册的应用执行初始同步
    for (const id of Object.keys(_syncApps)) {
      try { await fullSyncForApp(id, true); } catch(e) {}
    }

    renderSyncStatus();
    refreshSyncModal();
    startPolling();
    showToast("✅ GitHub 云同步已连接！");
  } catch (e) {
    localStorage.removeItem(GH_TOKEN_KEY);
    localStorage.removeItem(GH_GIST_KEY);
    errEl.textContent = "连接失败: " + e.message;
    errEl.style.display = "block";
  }
  btn.textContent = "🔗 连接"; btn.disabled = false;
}

function ghDisconnect() {
  if (!confirm("确定断开 GitHub 云同步？本地数据不会丢失。")) return;
  stopPolling();
  _lastKnownUpdatedAt = null;
  _syncStatus = "idle";
  localStorage.removeItem(GH_TOKEN_KEY);
  localStorage.removeItem(GH_GIST_KEY);
  for (const app of Object.values(_syncApps)) {
    localStorage.removeItem(app.syncTsKey);
  }
  renderSyncStatus();
  refreshSyncModal();
  showToast("已断开云同步");
}

// ==================== 手动同步 / 强制操作 ====================
async function doManualSync() {
  const btn = document.getElementById("syncNowBtn");
  if (btn) { btn.textContent = "同步中..."; btn.disabled = true; }
  try {
    await fullSyncForApp(_currentAppId, false);
  } catch (e) {}
  if (btn) { btn.innerHTML = "🔄 立即同步"; btn.disabled = false; }
}

async function ghForceUpload() {
  if (!confirm("将本地数据完全覆盖云端，确定？")) return;
  try {
    const allApps = Object.keys(_syncApps);
    // 前 n-1 个不写日志，最后一个写合并日志
    for (let i = 0; i < allApps.length; i++) {
      if (i < allApps.length - 1) {
        await ghPushApp(allApps[i], true); // skipLog
      } else {
        // 最后一个 push 带上所有 app 的日志
        _appendSyncLogEntry(allApps);
        const app = _syncApps[allApps[i]];
        const content = JSON.stringify(app.getLocalData());
        const files = { [app.gistFile]: { content }, [SYNC_LOG_FILE]: { content: _getSyncLogFileContent() } };
        const result = await ghAPI("https://api.github.com/gists/" + getGHGistId(), {
          method: "PATCH", body: JSON.stringify({ files })
        });
        localStorage.setItem(app.syncTsKey, Date.now().toString());
        if (result && result.updated_at) _lastKnownUpdatedAt = result.updated_at;
      }
    }
    syncLog("⬆ 已上传本地数据到云端");
  } catch (e) { syncLog("❌ 上传失败: " + e.message); }
}

async function ghForceDownload() {
  if (!confirm("用云端数据完全覆盖本地，确定？")) return;
  try {
    for (const appId in _syncApps) {
      const app = _syncApps[appId];
      const remote = await ghPullApp(appId);
      if (remote) {
        app.applyRemoteData(remote);
        if (app.onSyncComplete) app.onSyncComplete();
      }
    }
    syncLog("⬇ 已下载云端数据");
  } catch (e) { syncLog("❌ 下载失败: " + e.message); }
}

// ==================== 同步状态 UI ====================

/**
 * 渲染同步状态指示器到 topbar（替代旧版 ⬆⬇ 按钮）
 * 显示：🟢/🟡/🔴 状态点 + 相对时间 + ⚙ 设置按钮
 */
function renderSyncStatus() {
  const container = document.getElementById("syncButtonsArea");
  if (!container) return;

  if (!isGHConnected()) {
    container.innerHTML =
      '<button class="btn primary" onclick="openSyncSettings()">☁ 连接云同步</button>';
    return;
  }

  let dotColor, dotTitle, statusText;
  switch (_syncStatus) {
    case "syncing":
      dotColor = "#fbbf24"; // 黄色
      dotTitle = "同步中...";
      statusText = "同步中";
      break;
    case "synced":
      dotColor = "#4ade80"; // 绿色
      dotTitle = "已同步";
      statusText = _lastSyncTime ? _getRelativeTime(_lastSyncTime) : "已同步";
      break;
    case "error":
      dotColor = "#f87171"; // 红色
      dotTitle = "同步出错，将自动重试";
      statusText = "出错";
      break;
    default:
      dotColor = "#64748b"; // 灰色
      dotTitle = "等待同步";
      statusText = "就绪";
  }

  const spinnerStyle = _syncStatus === "syncing"
    ? "animation:spin 1s linear infinite;" : "";

  container.innerHTML =
    '<span onclick="openSyncLog()" style="display:inline-flex;align-items:center;gap:5px;margin-right:4px;cursor:pointer;" title="' + dotTitle + '（点击查看日志）">' +
      '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + dotColor + ';' + spinnerStyle + '"></span>' +
      '<span style="font-size:12px;color:#64748b;">' + statusText + '</span>' +
    '</span>' +
    '<button class="btn" onclick="openSyncSettings()" title="同步设置" style="font-size:12px;">⚙</button>';
}

function _getRelativeTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "刚刚";
  if (diff < 60) return diff + "秒前";
  if (diff < 3600) return Math.floor(diff / 60) + "分钟前";
  return Math.floor(diff / 3600) + "小时前";
}

// 每 5 秒更新一次相对时间显示
setInterval(() => {
  if (_syncStatus === "synced" && _lastSyncTime) renderSyncStatus();
}, 5000);

// 兼容旧函数名
function renderSyncButtons() { renderSyncStatus(); }
function updateSyncBadge() { renderSyncStatus(); }
function updateLastSyncBadge() {} // no-op, handled by renderSyncStatus
function updateLastSyncTime() {} // no-op

function syncLog(msg) {
  const el = document.getElementById("syncLog");
  if (el) {
    el.textContent = (el.textContent ? el.textContent + "\n" : "") + msg;
    el.scrollTop = el.scrollHeight;
  }
}

function openSyncSettings() {
  refreshSyncModal();
  showModal("syncModal");
}

function refreshSyncModal() {
  const body = document.getElementById("syncModalBody");
  if (!body) return;

  if (isGHConnected()) {
    const app = getCurrentSyncApp();
    const lastTs = app ? parseInt(localStorage.getItem(app.syncTsKey) || "0") : 0;
    body.innerHTML =
      '<div class="connected-info">' +
        '<div class="label">✅ 已连接 GitHub 云同步</div>' +
        '<div class="val">Gist ID: ' + getGHGistId() + '</div>' +
        (lastTs ? '<div style="font-size:12px;color:#6ee7b7;margin-top:4px">上次同步: ' + new Date(lastTs).toLocaleString("zh-CN") + '</div>' : '') +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">' +
        '<button class="btn primary" onclick="doManualSync()" style="flex:1;" id="syncNowBtn">🔄 立即同步</button>' +
        '<button class="btn" onclick="ghForceUpload()" style="flex:1;">⬆ 强制上传</button>' +
        '<button class="btn" onclick="ghForceDownload()" style="flex:1;">⬇ 强制下载</button>' +
      '</div>' +
      '<div id="syncLog" class="sync-log"></div>' +
      '<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;margin:12px 0;">' +
        '<div style="font-size:12px;color:#94a3b8;margin-bottom:6px;">📱 在其他设备上使用：</div>' +
        '<div style="font-size:12px;color:#64748b;line-height:1.8;">1. 打开同样的网页 URL<br>2. 点 ⚙ → 输入同样的 Token + 下方 Gist ID<br>3. 连接后自动实时同步</div>' +
        '<button class="btn" onclick="copyGistId()" style="margin-top:6px;font-size:12px;">📋 复制 Gist ID</button>' +
      '</div>' +
      '<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;margin:12px 0;">' +
        '<div style="font-size:12px;color:#94a3b8;margin-bottom:6px;">🖥 本设备名称:</div>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<input id="deviceNameInput" value="' + esc(getDeviceName()) + '" style="flex:1;background:#1e293b;border:1px solid #334155;border-radius:6px;padding:5px 8px;font-size:12px;color:#f1f5f9;outline:none;">' +
          '<button class="btn" onclick="setDeviceName(document.getElementById(\'deviceNameInput\').value);showToast(\'设备名已更新\')" style="font-size:12px;">保存</button>' +
        '</div>' +
        '<div style="font-size:12px;color:#475569;margin-top:4px;">用于同步日志中区分不同设备</div>' +
      '</div>' +
      '<div style="margin-bottom:10px;">' +
        '<button class="btn" onclick="closeModal(\'syncModal\');openSyncLog()" style="width:100%;font-size:12px;">📋 查看同步日志</button>' +
      '</div>' +
      '<div style="border-top:1px solid #334155;padding-top:10px;display:flex;align-items:center;justify-content:space-between;">' +
        '<span style="font-size:12px;color:#475569;">实时同步: 每 15 秒自动检测更新</span>' +
        '<button class="btn danger" onclick="ghDisconnect()" style="font-size:12px;">断开连接</button>' +
      '</div>';
  } else {
    body.innerHTML =
      '<p style="font-size:12px;color:#94a3b8;margin-bottom:12px;line-height:1.7;">' +
        '通过 <b style="color:#f1f5f9;">GitHub Gist</b> 实现多设备实时同步。<b style="color:#fbbf24;">免费、安全、全球可用。</b>' +
      '</p>' +
      '<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;margin-bottom:12px;">' +
        '<div style="font-size:13px;font-weight:600;color:#38bdf8;margin-bottom:8px;">📋 设置步骤（只需一次）</div>' +
        '<ol style="font-size:12px;color:#94a3b8;line-height:2.2;padding-left:20px;">' +
          '<li>打开 <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener" style="color:#38bdf8;text-decoration:underline;">GitHub Token 页面</a>（需登录 GitHub）</li>' +
          '<li>Note 填 <code style="background:#334155;padding:1px 4px;border-radius:3px;font-size:12px;">vocab-sync</code>，Expiration 选 <b style="color:#fbbf24;">No expiration</b></li>' +
          '<li>勾选 <b style="color:#fbbf24;">gist</b> 权限 → 点 Generate token</li>' +
          '<li>复制 token（以 <code style="background:#334155;padding:1px 4px;border-radius:3px;font-size:12px;">ghp_</code> 开头）粘贴到下方</li>' +
        '</ol>' +
      '</div>' +
      '<label style="display:block;font-size:12px;color:#64748b;margin-bottom:4px;">GitHub Personal Access Token</label>' +
      '<input id="ghTokenInput" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" style="width:100%;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:7px 10px;font-size:13px;color:#f1f5f9;outline:none;font-family:monospace;">' +
      '<div id="ghGistIdRow" style="margin-top:8px;display:none;">' +
        '<label style="display:block;font-size:12px;color:#64748b;margin-bottom:4px;">Gist ID（留空自动创建新 Gist）</label>' +
        '<input id="ghGistIdInput" placeholder="留空 = 自动创建" style="width:100%;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:7px 10px;font-size:12px;color:#f1f5f9;outline:none;font-family:monospace;">' +
        '<div style="font-size:12px;color:#475569;margin-top:3px;">第二台设备连接时，粘贴第一台设备显示的 Gist ID</div>' +
      '</div>' +
      '<div style="margin-top:6px;">' +
        '<a href="javascript:void(0)" onclick="document.getElementById(\'ghGistIdRow\').style.display=document.getElementById(\'ghGistIdRow\').style.display===\'none\'?\'block\':\'none\'" style="font-size:12px;color:#64748b;">▼ 已有 Gist？点击输入 Gist ID（第二台设备用）</a>' +
      '</div>' +
      '<div id="ghConnectError" class="err"></div>' +
      '<div style="margin-top:10px;display:flex;justify-content:flex-end;gap:8px;">' +
        '<button class="btn" onclick="closeModal(\'syncModal\')">取消</button>' +
        '<button class="btn primary" id="ghConnectBtn" onclick="ghConnect(\'ghTokenInput\',\'ghGistIdInput\',\'ghConnectError\',\'ghConnectBtn\')">🔗 连接</button>' +
      '</div>';
  }
}

// ==================== 同步日志 UI ====================
function openSyncLog() {
  if (!isGHConnected()) { openSyncSettings(); return; }
  const el = document.getElementById("syncLogPopup");
  if (el) { el.remove(); return; } // toggle
  _renderSyncLogPopup();
}

function _renderSyncLogPopup() {
  // 移除旧的
  const old = document.getElementById("syncLogPopup");
  if (old) old.remove();

  const popup = document.createElement("div");
  popup.id = "syncLogPopup";
  popup.style.cssText = "position:fixed;top:48px;right:12px;width:340px;max-height:420px;background:#1e293b;border:1px solid #334155;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:999;overflow:hidden;";

  // ── 顶部 Tab 切换：设备 | 日志 ──
  let html = '<div style="padding:10px 14px 0;border-bottom:1px solid #334155;">' +
    '<div style="display:flex;gap:0;">' +
      '<button class="btn" id="syncPopupTabDevices" onclick="_switchSyncPopupTab(\'devices\')" style="font-size:12px;border-radius:6px 6px 0 0;border-bottom:none;padding:6px 14px;">📱 设备</button>' +
      '<button class="btn" id="syncPopupTabLog" onclick="_switchSyncPopupTab(\'log\')" style="font-size:12px;border-radius:6px 6px 0 0;border-bottom:none;padding:6px 14px;">📋 变更日志</button>' +
    '</div>' +
  '</div>';

  // ── 设备面板 ──
  const devices = getDeviceList();
  html += '<div id="syncPopupDevices" style="overflow-y:auto;max-height:340px;padding:6px 0;">';
  if (!devices.length) {
    html += '<div style="padding:30px 14px;text-align:center;color:#475569;font-size:12px;">暂无设备记录</div>';
  } else {
    devices.forEach(d => {
      const statusDot = d.online
        ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#4ade80;margin-right:4px;" title="在线"></span>'
        : '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#475569;margin-right:4px;" title="离线"></span>';
      const nameColor = d.isMe ? "#38bdf8" : (d.online ? "#4ade80" : "#94a3b8");
      const lastSeenStr = d.lastSeen ? _getRelativeTime(new Date(d.lastSeen).getTime()) : "未知";
      const pageStr = d.page ? ' · ' + esc(d.page) + '页' : '';
      html += '<div style="padding:8px 14px;border-bottom:1px solid #1e293b44;display:flex;align-items:center;gap:10px;">' +
        '<span style="font-size:16px;">' + (d.isMe ? '💻' : '🖥') + '</span>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;align-items:center;gap:4px;">' +
            statusDot +
            '<span style="font-size:12px;font-weight:600;color:' + nameColor + ';">' + esc(d.name) + (d.isMe ? ' (本机)' : '') + '</span>' +
          '</div>' +
          '<div style="font-size:12px;color:#64748b;margin-top:2px;">' +
            (d.online ? '🟢 在线' + pageStr : '⏱ 最后活跃: ' + lastSeenStr) +
          '</div>' +
        '</div>' +
        (d.isMe ? '<a href="javascript:void(0)" onclick="_editDeviceName()" style="font-size:12px;color:#475569;">✏</a>' : '') +
      '</div>';
    });
  }
  html += '</div>';

  // ── 变更日志面板 ──
  html += '<div id="syncPopupLog" style="overflow-y:auto;max-height:340px;padding:6px 0;display:none;">';
  if (!_syncLogEntries.length) {
    html += '<div style="padding:30px 14px;text-align:center;color:#475569;font-size:12px;">暂无变更记录</div>';
  } else {
    _syncLogEntries.forEach(entry => {
      const t = new Date(entry.time);
      const timeStr = t.getMonth() + 1 + "/" + t.getDate() + " " +
        t.getHours().toString().padStart(2, "0") + ":" + t.getMinutes().toString().padStart(2, "0") + ":" + t.getSeconds().toString().padStart(2, "0");
      const isMe = entry.device === getDeviceName();
      const deviceColor = isMe ? "#4ade80" : "#fbbf24";
      const deviceIcon = isMe ? "💻" : "🖥";
      html += '<div style="padding:7px 14px;border-bottom:1px solid #1e293b44;display:flex;align-items:flex-start;gap:8px;">' +
        '<span style="font-size:13px;flex-shrink:0;margin-top:1px;">' + deviceIcon + '</span>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;">' +
            '<span style="font-size:12px;font-weight:600;color:' + deviceColor + ';">' + esc(entry.device) + '</span>' +
            '<span style="font-size:12px;color:#475569;">' + timeStr + '</span>' +
          '</div>' +
          '<div style="font-size:12px;color:#94a3b8;margin-top:2px;">' + (entry.desc ? esc(entry.desc) : '更新: ' + esc(entry.apps.join("、"))) + (entry.page ? ' <span style="color:#475569;">(' + esc(entry.page) + '页)</span>' : '') + '</div>' +
        '</div>' +
      '</div>';
    });
  }
  html += '</div>';

  html += '<div style="padding:8px 14px;border-top:1px solid #334155;text-align:right;">' +
    '<button class="btn" onclick="document.getElementById(\'syncLogPopup\').remove()" style="font-size:12px;">关闭</button>' +
  '</div>';

  popup.innerHTML = html;
  document.body.appendChild(popup);

  // 默认激活"设备"标签
  _switchSyncPopupTab("devices");

  // 点击外部关闭
  setTimeout(() => {
    const handler = (e) => {
      if (!popup.contains(e.target) && !e.target.closest("#syncButtonsArea")) {
        popup.remove();
        document.removeEventListener("click", handler);
      }
    };
    document.addEventListener("click", handler);
  }, 100);
}

function _switchSyncPopupTab(tab) {
  const devPanel = document.getElementById("syncPopupDevices");
  const logPanel = document.getElementById("syncPopupLog");
  const devTab = document.getElementById("syncPopupTabDevices");
  const logTab = document.getElementById("syncPopupTabLog");
  if (!devPanel || !logPanel) return;
  if (tab === "devices") {
    devPanel.style.display = ""; logPanel.style.display = "none";
    devTab.style.background = "#334155"; devTab.style.color = "#f1f5f9";
    logTab.style.background = ""; logTab.style.color = "";
  } else {
    devPanel.style.display = "none"; logPanel.style.display = "";
    logTab.style.background = "#334155"; logTab.style.color = "#f1f5f9";
    devTab.style.background = ""; devTab.style.color = "";
  }
}

function _editDeviceName() {
  const current = getDeviceName();
  const name = prompt("设置本设备名称（方便在日志中识别）:", current);
  if (name !== null && name.trim()) {
    setDeviceName(name.trim());
    _renderSyncLogPopup(); // 刷新
    showToast("设备名已更新: " + name.trim());
  }
}

function copyGistId() {
  const id = getGHGistId();
  if (!id) return;
  navigator.clipboard.writeText(id).then(() => {
    showToast("📋 Gist ID 已复制: " + id.slice(0, 8) + "...");
  }).catch(() => {
    prompt("请手动复制:", id);
  });
}

// ==================== 自动同步 & 初始化 ====================

/**
 * 初始化同步系统
 * 页面加载时调用，执行首次同步并启动 15s 轮询
 */
async function initSync() {
  renderSyncStatus();

  if (isGHConnected()) {
    // 首次同步：拉取远端数据
    try {
      for (const appId in _syncApps) {
        await fullSyncForApp(appId, true);
      }
    } catch (e) {
      console.warn("Init sync failed:", e);
    }
    // 启动实时轮询
    startPolling();
  }
}

/**
 * 延迟推送（本地操作后自动上传）
 * 调用方式：debouncedPush()
 * push 成功后更新 _lastKnownUpdatedAt，避免自己的推送触发下一次 poll 的 apply
 */
let _pushTimer = null;
let _pendingChangeDescs = [];  // 收集 debounce 期间的所有变更描述
let _pushRetryCount = 0;
const MAX_PUSH_RETRIES = 5;

// 内部核心：执行一次实际 push（被 debouncedPush 和 flushPush 共用）
async function _doPushNow(targetAppId) {
  if (!isGHConnected()) return;
  // 等待正在进行的同步操作完成
  if (_isSyncing) {
    _pushRetryCount++;
    if (_pushRetryCount > MAX_PUSH_RETRIES) {
      console.warn("[sync] push abandoned after " + MAX_PUSH_RETRIES + " retries");
      _pushRetryCount = 0;
      return;
    }
    console.log("[sync] push delayed: sync in progress (retry " + _pushRetryCount + ")");
    await new Promise(r => setTimeout(r, 2000));
    return _doPushNow(targetAppId);
  }
  _pushRetryCount = 0;
  _isSyncing = true;
  // 合并多个变更描述（debounce 期间的操作合并为一条日志）
  const changeDesc = _pendingChangeDescs.length
    ? [...new Set(_pendingChangeDescs)].join("、")
    : null;
  _pendingChangeDescs = [];
  var pushId = (targetAppId && _syncApps[targetAppId]) ? targetAppId : _currentAppId;
  try {
    const result = await ghPushApp(pushId, false, changeDesc);
    // 更新 updated_at，这样下次 poll 不会把自己的修改当成远端更新
    if (result && result.updated_at) {
      _lastKnownUpdatedAt = result.updated_at;
    }
    _syncStatus = "synced";
    _lastSyncTime = Date.now();
    renderSyncStatus();
    return result;
  } catch (e) {
    console.warn("[sync] push failed:", e);
    throw e;
  } finally {
    _isSyncing = false;
  }
}

function debouncedPush(appIdOrDesc, desc) {
  // Support both debouncedPush("desc") and debouncedPush("appId", "desc")
  var targetAppId, changeDescArg;
  if (desc !== undefined) {
    targetAppId = appIdOrDesc;
    changeDescArg = desc;
  } else {
    targetAppId = null;
    changeDescArg = appIdOrDesc;
  }
  if (changeDescArg) _pendingChangeDescs.push(changeDescArg);
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    _pushTimer = null;
    _doPushNow(targetAppId).catch(() => {});
  }, 3000);
}

/**
 * 立即 push（跳过 3s debounce），用于关键单次操作（如关联 PDF、重置 PDF）。
 * 返回 Promise，可 await 以拿到 push 完成时机。
 */
async function flushPush(appIdOrDesc, desc) {
  var targetAppId, changeDescArg;
  if (desc !== undefined) {
    targetAppId = appIdOrDesc;
    changeDescArg = desc;
  } else {
    targetAppId = null;
    changeDescArg = appIdOrDesc;
  }
  if (changeDescArg) _pendingChangeDescs.push(changeDescArg);
  // 取消任何挂起的 debounce 计时器（它们产生的 push 会被本次覆盖）
  if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
  return _doPushNow(targetAppId);
}

/**
 * 推送所有已注册的应用（用于跨应用数据变更）
 */
async function debouncedPushAll() {
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(async () => {
    if (!isGHConnected()) return;
    if (_isSyncing) {
      _pushRetryCount++;
      if (_pushRetryCount > MAX_PUSH_RETRIES) {
        console.warn("[sync] pushAll abandoned after " + MAX_PUSH_RETRIES + " retries");
        _pushRetryCount = 0;
        return;
      }
      console.log("[sync] pushAll delayed: sync in progress (retry " + _pushRetryCount + ")");
      setTimeout(() => debouncedPushAll(), 2000);
      return;
    }
    _pushRetryCount = 0;
    _isSyncing = true;
    try {
      let result;
      for (const appId in _syncApps) {
        result = await ghPushApp(appId);
      }
      if (result && result.updated_at) {
        _lastKnownUpdatedAt = result.updated_at;
      }
      _syncStatus = "synced";
      _lastSyncTime = Date.now();
      renderSyncStatus();
    } catch (e) {
      console.warn("[sync] debounced push all failed:", e);
    } finally {
      _isSyncing = false;
    }
  }, 3000);
}

// 兼容旧代码中的 quickUpload / quickDownload（不再在 UI 上显示，但保留函数）
async function quickUpload() { await ghForceUpload(); }
async function quickDownload() { await ghForceDownload(); }
