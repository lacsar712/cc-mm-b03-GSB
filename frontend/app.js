const tokenKey = "methane_token";
let token = localStorage.getItem(tokenKey) || "";
let role = localStorage.getItem("methane_role") || "";

const loginBox = document.querySelector("#login");
const appBox = document.querySelector("#app");
const rows = document.querySelector("#rows");
const live = document.querySelector("#live");
const form = document.querySelector("#form");
const watchToggle = document.querySelector("#watchToggle");
const watchPanel = document.querySelector("#watchPanel");
const watchRows = document.querySelector("#watchRows");
const watchHistory = document.querySelector("#watchHistory");
const watchForm = document.querySelector("#watchForm");

let watchedSites = new Set();

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function paint(list) {
  rows.innerHTML = list
    .map((r) => {
      const canPin = role === "writer" && !watchedSites.has(r.site);
      return `<tr><td>${esc(r.site)}</td><td>${r.ch4_pct}</td><td class="${r.level === "报警" ? "alarm" : "ok"}">${esc(r.level)}</td><td>${esc(r.note)}</td>${canPin ? `<td><button class="pin" data-site="${esc(r.site)}">钉上</button></td>` : "<td></td>"}</tr>`;
    })
    .join("");
}

function fmtTime(t) {
  if (!t) return "";
  return new Date(t).toLocaleString();
}

function paintWatchlist(data) {
  watchedSites = new Set(data.items.map((i) => i.site));
  watchRows.innerHTML = data.items
    .map((i) => {
      const cls = i.level === "报警" ? "alarm" : "ok";
      const remove =
        role === "writer"
          ? `<button class="unpin" data-site="${esc(i.site)}">取下</button>`
          : "";
      return `<tr><td>${esc(i.site)}</td><td>${i.ch4_pct ?? "—"}</td><td class="${cls}">${i.level ? esc(i.level) : "—"}</td><td>${i.note ? esc(i.note) : "—"}</td><td>${remove}</td></tr>`;
    })
    .join("");
}

function paintHistory(events) {
  watchHistory.innerHTML = events
    .map(
      (e) =>
        `<tr><td>${fmtTime(e.created_at)}</td><td>${esc(e.username)}</td><td>${esc(e.action)}</td><td>${esc(e.site)}</td></tr>`,
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
  watchToggle.hidden = false;
  watchForm.hidden = role !== "writer";
  form.hidden = role !== "writer";
  connect();
  load();
}

async function load() {
  // 先拿关注名单再画主表，以决定哪些测点还显示“钉上”按钮
  const [list, w] = await Promise.all([
    api("/api/readings"),
    api("/api/watchlist"),
  ]);
  watchedSites = new Set(w.items.map((i) => i.site));
  paint(list);
}

async function loadWatchPanel() {
  const [w, h] = await Promise.all([
    api("/api/watchlist"),
    api("/api/watchlist/history"),
  ]);
  paintWatchlist(w);
  paintHistory(h);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/alerts`);
  ws.onmessage = () => {
    load();
    if (!watchPanel.hidden) loadWatchPanel();
  };
}

watchToggle.onclick = async () => {
  watchPanel.hidden = !watchPanel.hidden;
  if (!watchPanel.hidden) await loadWatchPanel();
};

watchForm.onsubmit = async (e) => {
  e.preventDefault();
  const input = document.querySelector("#watchSite");
  try {
    await api("/api/watchlist", { method: "POST", body: JSON.stringify({ site: input.value }) });
    input.value = "";
    await Promise.all([loadWatchPanel(), load()]);
  } catch (err) {
    live.textContent = err.message;
  }
};

rows.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.pin");
  if (!btn) return;
  try {
    await api("/api/watchlist", {
      method: "POST",
      body: JSON.stringify({ site: btn.dataset.site }),
    });
    await load();
    if (!watchPanel.hidden) await loadWatchPanel();
  } catch (err) {
    live.textContent = err.message;
  }
});

watchRows.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.unpin");
  if (!btn) return;
  try {
    await api(`/api/watchlist?site=${encodeURIComponent(btn.dataset.site)}`, {
      method: "DELETE",
    });
    await Promise.all([loadWatchPanel(), load()]);
  } catch (err) {
    live.textContent = err.message;
  }
});

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

if (token) showApp();
