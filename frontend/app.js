const tokenKey = "methane_token";
let token = localStorage.getItem(tokenKey) || "";
let role = localStorage.getItem("methane_role") || "";

const loginBox = document.querySelector("#login");
const appBox = document.querySelector("#app");
const rows = document.querySelector("#rows");
const live = document.querySelector("#live");
const form = document.querySelector("#form");
const watchEntry = document.querySelector("#watchEntry");
const watchPanel = document.querySelector("#watchPanel");
const watchClose = document.querySelector("#watchClose");
const watchAdd = document.querySelector("#watchAdd");
const watchSite = document.querySelector("#watchSite");
const watchSites = document.querySelector("#watchSites");
const watchHistory = document.querySelector("#watchHistory");

function paint(list) {
  rows.innerHTML = list
    .map(
      (r) =>
        `<tr><td>${r.site}</td><td>${r.ch4_pct}</td><td class="${r.level === "报警" ? "alarm" : "ok"}">${r.level}</td><td>${r.note}</td></tr>`,
    )
    .join("");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "请求失败");
  return data;
}

function showApp() {
  loginBox.hidden = true;
  appBox.hidden = false;
  document.querySelector("#who").textContent = role === "writer" ? "检查员" : "查看";
  document.querySelector("#out").hidden = false;
  watchEntry.hidden = false;
  watchAdd.hidden = role !== "writer";
  form.hidden = role !== "writer";
  connect();
  load();
}

async function load() {
  paint(await api("/api/readings"));
}

function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

async function loadWatchlist() {
  const data = await api("/api/watchlist");
  if (!data.sites.length) {
    watchSites.innerHTML = `<p class="muted">${
      role === "writer" ? "还没有钉住的测点，在上方输入点名钉上。" : "检查员还没有钉住任何测点。"
    }</p>`;
    return;
  }
  watchSites.innerHTML = data.sites
    .map(
      (s) => `
      <div class="watchRow">
        <span class="site">${s.site}</span>
        <div class="val">${s.ch4_pct === null ? "无上报" : s.ch4_pct + " %"}
          <span class="${s.level === "报警" ? "alarm" : "ok"}">${s.level}</span>
        </div>
        <span class="muted">${s.note}</span>
        <time class="muted">最新上报：${s.latest_at ? fmtTime(s.latest_at) : "—"}</time>
        ${role === "writer" ? `<button type="button" data-remove="${s.site}">移除</button>` : ""}
      </div>`,
    )
    .join("");
}

async function loadWatchHistory() {
  const events = await api("/api/watchlist/history");
  if (!events.length) {
    watchHistory.innerHTML = `<p class="muted">暂无变更。</p>`;
    return;
  }
  watchHistory.innerHTML =
    "<ul>" +
    events
      .map((e) => {
        const verb = e.action === "add" ? "钉上" : "移除";
        return `<li>${fmtTime(e.created_at)} ${e.operator} ${verb} ${e.site}</li>`;
      })
      .join("") +
    "</ul>";
}

async function refreshWatchPanel() {
  if (!watchPanel.classList.contains("open")) return;
  try {
    await Promise.all([loadWatchlist(), loadWatchHistory()]);
  } catch (err) {
    watchSites.textContent = err.message;
  }
}

function openWatchPanel() {
  watchPanel.hidden = false;
  requestAnimationFrame(() => watchPanel.classList.add("open"));
  refreshWatchPanel();
}

function closeWatchPanel() {
  watchPanel.classList.remove("open");
  setTimeout(() => (watchPanel.hidden = true), 200);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/alerts`);
  ws.onmessage = (ev) => {
    const row = JSON.parse(ev.data);
    live.textContent = `刚推送：${row.site} ${row.level}`;
    load();
    refreshWatchPanel();
  };
}

document.querySelector("#go").onclick = async () => {
  const data = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: document.querySelector("#user").value,
      password: document.querySelector("#pass").value,
    }),
  });
  token = data.access_token;
  role = data.role;
  localStorage.setItem(tokenKey, token);
  localStorage.setItem("methane_role", role);
  showApp();
};

form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/readings", {
      method: "POST",
      body: JSON.stringify({
        site: document.querySelector("#site").value,
        ch4_pct: Number(document.querySelector("#ch4").value),
      }),
    });
  } catch (err) {
    live.textContent = err.message;
  }
};

document.querySelector("#out").onclick = () => {
  localStorage.clear();
  location.reload();
};

watchEntry.onclick = openWatchPanel;
watchClose.onclick = closeWatchPanel;

watchAdd.onsubmit = async (e) => {
  e.preventDefault();
  const site = watchSite.value.trim();
  if (!site) return;
  try {
    await api("/api/watchlist", { method: "POST", body: JSON.stringify({ site }) });
    watchSite.value = "";
    await refreshWatchPanel();
  } catch (err) {
    watchSites.textContent = err.message;
  }
};

watchSites.onclick = async (e) => {
  const btn = e.target.closest("button[data-remove]");
  if (!btn) return;
  try {
    await api(`/api/watchlist/${encodeURIComponent(btn.dataset.remove)}`, { method: "DELETE" });
    await refreshWatchPanel();
  } catch (err) {
    watchSites.textContent = err.message;
  }
};

if (token) showApp();
