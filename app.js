const SN_KEYS = ["sn", "serial", "serial number", "serialnumber", "序列号", "主机编号", "s/n"];

let results = [];
let stopRequested = false;

const els = {
  region: document.getElementById("region"),
  clientIdWrap: document.getElementById("clientid-wrap"),
  clientId: document.getElementById("client-id"),
  delayMs: document.getElementById("delay-ms"),
  modeHint: document.getElementById("mode-hint"),
  snInput: document.getElementById("sn-input"),
  excelInput: document.getElementById("excel-input"),
  btnQuery: document.getElementById("btn-query"),
  btnExport: document.getElementById("btn-export"),
  btnStop: document.getElementById("btn-stop"),
  btnReset: document.getElementById("btn-reset"),
  btnClearInput: document.getElementById("btn-clear-input"),
  progress: document.getElementById("progress"),
  errorMsg: document.getElementById("error-msg"),
  statsBar: document.getElementById("stats-bar"),
  tableSection: document.getElementById("table-section"),
  resultBody: document.getElementById("result-body"),
  statTotal: document.getElementById("stat-total"),
  statActive: document.getElementById("stat-active"),
  statExpired: document.getElementById("stat-expired"),
  statUnknown: document.getElementById("stat-unknown"),
};

function isLocalServer() {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}

function isVercelHost() {
  return window.location.hostname.endsWith(".vercel.app");
}

function getApiBase() {
  if (isLocalServer() || isVercelHost()) return "";
  const custom = window.LENOVO_API_BASE;
  if (custom && typeof custom === "string") return custom.replace(/\/$/, "");
  return "";
}

function canQueryOnline() {
  return isLocalServer() || isVercelHost() || Boolean(getApiBase());
}

function updateModeHint() {
  const region = els.region.value;
  els.clientIdWrap.classList.toggle("hidden", region !== "global");
  if (isLocalServer()) {
    els.modeHint.textContent =
      "当前为本地服务模式，查询通过本机代理转发。";
  } else if (isVercelHost()) {
    els.modeHint.textContent =
      "当前为在线部署模式，可直接查询；将此页面链接发给他人即可使用。";
  } else if (getApiBase()) {
    els.modeHint.textContent = `已配置 API：${getApiBase()}`;
  } else {
    els.modeHint.textContent =
      "当前页面无法直接查询。请部署到 Vercel 获取固定链接，或运行 ./start.sh 本地使用。详见 DEPLOY-SHARE.md";
  }
}

function showError(msg) {
  els.errorMsg.hidden = !msg;
  els.errorMsg.textContent = msg || "";
}

function parseSnList(text) {
  return [
    ...new Set(
      text
        .split(/[\s,;，；\n\r\t]+/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length >= 6 && s.length <= 20)
    ),
  ];
}

function findSnColumn(rows) {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  for (const key of keys) {
    const norm = key.trim().toLowerCase();
    if (SN_KEYS.some((k) => norm === k || norm.includes(k))) return key;
  }
  return keys[0];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDate(val) {
  if (!val) return "";
  const s = String(val);
  if (s.includes("T")) return s.split("T")[0];
  return s.slice(0, 10);
}

function warrantyStatusFromEnd(endStr) {
  if (!endStr) return "未知";
  const end = new Date(formatDate(endStr));
  if (Number.isNaN(end.getTime())) return "未知";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return end >= today ? "在保" : "已过保";
}

function badgeClass(status) {
  if (status === "在保") return "ok";
  if (status === "已过保") return "warn";
  if (status === "未查到" || status === "查询失败") return "err";
  return "muted";
}

function normalizeRow(sn, data) {
  return {
    sn,
    model: data.model || "—",
    status: data.status || "未查到",
    start: data.start || "",
    end: data.end || "",
    warrantyType: data.warrantyType || "",
    note: data.note || "",
  };
}

async function lookupOne(sn) {
  const region = els.region.value;
  const clientId = els.clientId.value.trim();
  const params = new URLSearchParams({ sn, region });
  if (clientId) params.set("clientId", clientId);

  const base = getApiBase();
  const url = `${base}/api/lookup?${params.toString()}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return normalizeRow(sn, json);
}

function updateStats() {
  const total = results.length;
  const active = results.filter((r) => r.status === "在保").length;
  const expired = results.filter((r) => r.status === "已过保").length;
  const unknown = results.filter(
    (r) => r.status === "未查到" || r.status === "查询失败" || r.status === "未知"
  ).length;
  els.statTotal.textContent = total;
  els.statActive.textContent = active;
  els.statExpired.textContent = expired;
  els.statUnknown.textContent = unknown;
}

function renderTable() {
  els.resultBody.innerHTML = results
    .map(
      (r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><code>${escapeHtml(r.sn)}</code></td>
      <td>${escapeHtml(r.model)}</td>
      <td><span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
      <td>${escapeHtml(r.start)}</td>
      <td>${escapeHtml(r.end)}</td>
      <td>${escapeHtml(r.warrantyType)}</td>
      <td>${escapeHtml(r.note)}</td>
    </tr>`
    )
    .join("");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function runQuery() {
  if (!canQueryOnline()) {
    showError(
      "当前地址无法查询。请用 Vercel 部署后分享链接（见 DEPLOY-SHARE.md），或本机运行 ./start.sh 打开 http://localhost:8766"
    );
    return;
  }

  const sns = parseSnList(els.snInput.value);
  if (!sns.length) {
    showError("请输入至少一个有效的 SN（通常 7～8 位字母数字）。");
    return;
  }

  if (els.region.value === "global" && !els.clientId.value.trim()) {
    showError("国际 API 需要填写 ClientID（向联想客户经理申请）。");
    return;
  }

  showError("");
  stopRequested = false;
  results = [];
  els.btnQuery.disabled = true;
  els.btnStop.disabled = false;
  els.btnExport.disabled = true;
  els.statsBar.hidden = false;
  els.tableSection.hidden = false;
  els.progress.hidden = false;

  const delay = Math.max(100, Number(els.delayMs.value) || 400);

  for (let i = 0; i < sns.length; i++) {
    if (stopRequested) break;
    const sn = sns[i];
    els.progress.textContent = `正在查询 ${i + 1} / ${sns.length}：${sn}`;

    try {
      const row = await lookupOne(sn);
      results.push(row);
    } catch (err) {
      results.push(
        normalizeRow(sn, {
          status: "查询失败",
          note: err.message || "请求失败",
        })
      );
    }

    renderTable();
    updateStats();
    if (i < sns.length - 1 && !stopRequested) await sleep(delay);
  }

  els.progress.textContent = stopRequested
    ? `已停止，已完成 ${results.length} 条`
    : `查询完成，共 ${results.length} 条`;
  els.btnQuery.disabled = false;
  els.btnStop.disabled = true;
  els.btnExport.disabled = results.length === 0;
}

function exportExcel() {
  if (!results.length) return;
  const dateStr = new Date().toISOString().slice(0, 10);
  const sheet = XLSX.utils.json_to_sheet(
    results.map((r) => ({
      序列号: r.sn,
      型号: r.model,
      保修状态: r.status,
      保修开始: r.start,
      保修结束: r.end,
      保修类型: r.warrantyType,
      备注: r.note,
    }))
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "保修查询结果");
  XLSX.writeFile(wb, `ThinkPad保修查询_${dateStr}.xlsx`);
}

els.region.addEventListener("change", () => {
  updateModeHint();
  localStorage.setItem("lenovo-region", els.region.value);
});

els.clientId.addEventListener("change", () => {
  localStorage.setItem("lenovo-client-id", els.clientId.value);
});

els.excelInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const col = findSnColumn(rows);
    const sns = rows
      .map((r) => String(r[col] ?? "").trim())
      .filter(Boolean);
    if (!sns.length) throw new Error("未在 Excel 中找到 SN 列");
    const existing = parseSnList(els.snInput.value);
    els.snInput.value = [...new Set([...existing, ...sns.map((s) => s.toUpperCase())])].join("\n");
    showError("");
  } catch (err) {
    showError(err.message || "Excel 导入失败");
  }
  e.target.value = "";
});

els.btnQuery.addEventListener("click", runQuery);
els.btnStop.addEventListener("click", () => {
  stopRequested = true;
});
els.btnExport.addEventListener("click", exportExcel);
els.btnClearInput.addEventListener("click", () => {
  els.snInput.value = "";
});
els.btnReset.addEventListener("click", () => {
  results = [];
  els.resultBody.innerHTML = "";
  els.statsBar.hidden = true;
  els.tableSection.hidden = true;
  els.progress.hidden = true;
  els.btnExport.disabled = true;
  showError("");
});

const savedRegion = localStorage.getItem("lenovo-region");
const savedClientId = localStorage.getItem("lenovo-client-id");
if (savedRegion) els.region.value = savedRegion;
if (savedClientId) els.clientId.value = savedClientId;
updateModeHint();
