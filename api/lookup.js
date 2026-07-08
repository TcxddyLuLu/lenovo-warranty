/** Vercel / Node serverless：联想保修查询代理 */

const CN_WARRANTY_API =
  "https://newsupport.lenovo.com.cn/api/drive/{sn}/drivewarrantyinfo";
const CN_MACHINE_APIS = [
  "https://newthink.lenovo.com.cn/api/ThinkHome/Machine/MachineListInfo?sn={sn}",
  "https://newsupport.lenovo.com.cn/api/ThinkHome/Machine/MachineListInfo?sn={sn}",
];
const GLOBAL_API = "https://supportapi.lenovo.com/v2.5/warranty?Serial={sn}";

const MODEL_KEYS = new Set([
  "product_model",
  "ProductName",
  "productName",
  "CatalogName",
  "MachineType",
  "machineType",
  "machine_mtm",
  "MTM",
  "Name",
  "machin_describe",
  "product_line_name",
  "product_series",
  "MaterialName",
  "ProductDesc",
  "product",
  "productName",
]);

function firstNonempty(...values) {
  for (const v of values) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s && s !== "N/A" && s !== "—") return s;
  }
  return "";
}

function parseDate(val) {
  if (!val) return "";
  const s = String(val);
  return s.includes("T") ? s.split("T")[0] : s.slice(0, 10);
}

function warrantyStatus(end) {
  if (!end) return "未知";
  const d = new Date(parseDate(end));
  if (Number.isNaN(d.getTime())) return "未知";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(23, 59, 59, 999);
  return d >= today ? "在保" : "已过保";
}

function isEmptyModel(model) {
  return !model || model === "—";
}

function formatModel(name, mtm) {
  const n = firstNonempty(name);
  const m = firstNonempty(mtm);
  if (n && m && !n.includes(m)) return `${n} (${m})`;
  return n || m || "";
}

function deepFindModel(obj, depth = 0, seen = new Set()) {
  if (!obj || typeof obj !== "object" || depth > 6 || seen.has(obj)) return "";
  seen.add(obj);

  for (const key of MODEL_KEYS) {
    if (!(key in obj)) continue;
    const val = obj[key];
    if (typeof val !== "string" && typeof val !== "number") continue;
    const s = String(val).trim();
    if (!s || s.length < 2) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) continue;
    if (/^N\/A$/i.test(s)) continue;
    return s;
  }

  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        const found = deepFindModel(item, depth + 1, seen);
        if (found) return found;
      }
    } else if (val && typeof val === "object") {
      const found = deepFindModel(val, depth + 1, seen);
      if (found) return found;
    }
  }
  return "";
}

function parseMachineListInfo(payload) {
  if (!payload || payload.statusCode !== 200) return "";
  const row = payload.data?.data;
  if (!row || typeof row !== "object") return "";
  return formatModel(
    firstNonempty(
      row.product_model,
      row.product_line_name,
      row.machin_describe,
      row.product_series
    ),
    row.machine_mtm
  );
}

async function fetchCnMachineModel(sn) {
  for (const template of CN_MACHINE_APIS) {
    try {
      const url = template.replace("{sn}", encodeURIComponent(sn));
      const r = await fetch(url);
      const payload = await r.json();
      const model = parseMachineListInfo(payload);
      if (model) return model;
    } catch {
      /* try next endpoint */
    }
  }
  return "";
}

function mergeModel(result, extraModel) {
  if (!isEmptyModel(extraModel)) {
    if (isEmptyModel(result.model)) {
      result.model = extraModel;
    } else if (!result.model.includes(extraModel)) {
      result.model = `${result.model} (${extraModel})`;
    }
  } else if (isEmptyModel(result.model)) {
    result.model = "—";
  }
  return result;
}

function parseCn(payload) {
  const msg = firstNonempty(
    typeof payload.message === "string" ? payload.message : "",
    payload.msg
  );
  const data = payload.data;
  if (!data) {
    return mergeModel(
      { model: "", status: "未查到", note: msg || "无返回数据" },
      deepFindModel(payload)
    );
  }
  if (Array.isArray(data) && data.length === 0) {
    return mergeModel(
      { model: "", status: "未查到", note: msg || "保修信息不存在" },
      ""
    );
  }

  let baseinfo = [];
  let product = deepFindModel(payload);
  if (typeof data === "object" && !Array.isArray(data)) {
    baseinfo = data.baseinfo || data.baseInfo || [];
    product = firstNonempty(
      product,
      data.ProductName,
      data.productName,
      data.CatalogName,
      data.MachineType,
      data.machineType,
      data.machine_mtm,
      data.Name
    );
  }
  if (!Array.isArray(baseinfo)) baseinfo = [];
  if (!baseinfo.length && typeof data === "object" && !Array.isArray(data)) {
    baseinfo = [data];
  }

  const starts = [];
  const ends = [];
  const types = [];
  for (const item of baseinfo) {
    if (!item || typeof item !== "object") continue;
    starts.push(parseDate(item.StartDate || item.startDate || item.Start));
    ends.push(parseDate(item.EndDate || item.endDate || item.End));
    types.push(
      firstNonempty(
        item.Name,
        item.WarrantyName,
        item.Title,
        item.ServiceName,
        item.Description
      )
    );
    product = firstNonempty(
      product,
      item.ProductName,
      item.CatalogName,
      item.MachineType,
      item.machine_mtm,
      item.ProductDesc,
      deepFindModel(item)
    );
  }

  const start = starts.filter(Boolean).sort()[0] || "";
  const end = ends.filter(Boolean).sort().pop() || "";
  const wtype = [...new Set(types.filter(Boolean))].join("；");

  if (!product && !start && !end) {
    return mergeModel(
      { model: "", status: "未查到", note: msg || "未解析到保修字段" },
      ""
    );
  }

  return mergeModel(
    {
      model: product,
      status: end ? warrantyStatus(end) : "未知",
      start,
      end,
      warrantyType: wtype,
      note: msg,
    },
    ""
  );
}

async function lookupCn(sn) {
  const warrantyUrl = CN_WARRANTY_API.replace("{sn}", encodeURIComponent(sn));
  const [warrantyRes, machineModel] = await Promise.all([
    fetch(warrantyUrl).then((r) => r.json()),
    fetchCnMachineModel(sn),
  ]);

  const result = parseCn(warrantyRes);
  return mergeModel(result, machineModel);
}

function parseGlobal(payload) {
  let p = payload;
  if (Array.isArray(p)) p = p[0] || {};
  const product = firstNonempty(p.Product, p.Name, p.MachineType, p.Serial);
  let warranties = p.Warranty || p.warranty || [];
  if (!Array.isArray(warranties)) warranties = [];

  const starts = [];
  const ends = [];
  const names = [];
  for (const w of warranties) {
    if (!w || typeof w !== "object") continue;
    starts.push(parseDate(w.Start));
    ends.push(parseDate(w.End));
    names.push(firstNonempty(w.Name, w.Description));
  }

  const start = starts.filter(Boolean).sort()[0] || "";
  const end = ends.filter(Boolean).sort().pop() || "";
  const wtype = [...new Set(names.filter(Boolean))].join("；");

  if (!product && !start && !end) {
    return { model: "—", status: "未查到", note: "未返回保修信息" };
  }
  return {
    model: product || "—",
    status: end ? warrantyStatus(end) : "未知",
    start,
    end,
    warrantyType: wtype,
    note: "",
  };
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const sn = String(req.query.sn || "")
    .trim()
    .toUpperCase();
  const region = String(req.query.region || "cn").toLowerCase();
  const clientId = String(req.query.clientId || "").trim();

  if (!/^[A-Z0-9]{6,20}$/.test(sn)) {
    return res.status(400).json({ error: "无效的 SN 格式" });
  }

  try {
    if (region === "global") {
      if (!clientId) return res.status(400).json({ error: "国际查询需要 ClientID" });
      const url = GLOBAL_API.replace("{sn}", encodeURIComponent(sn));
      const r = await fetch(url, { headers: { ClientID: clientId } });
      const payload = await r.json();
      if (!r.ok) return res.status(502).json({ error: `联想接口 HTTP ${r.status}` });
      return res.status(200).json(parseGlobal(payload));
    }

    const result = await lookupCn(sn);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: e.message || "查询失败" });
  }
}
