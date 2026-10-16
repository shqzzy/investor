/* =====================================================
   每日价格更新 + Supabase 保活（update_prices.js）
   -----------------------------------------------------
   改造点（相对原本地脚本）：
     1. 全部配置走环境变量，可在 GitHub Actions 里用 Secrets 注入
     2. 行情源支持自动降级：tencent -> sina -> stooq -> yahoo
     3. 每只股票重试 MAX_RETRY 次，避免偶发网络抖动导致漏更新
     4. 每个请求带超时（AbortController），防止卡死拖垮 workflow
     5. 强制"数据库活动"：无论有没有股票都会读写一次，兼作保活
     6. 输出 GitHub Actions 的 Step Summary，方便在网页上看结果

   用法：
     本地：node --env-file=.env scripts/update_prices.js
     CI  ：node scripts/update_prices.js
   ===================================================== */
"use strict";

const config = require("./config");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const now = () => new Date().toISOString();
const log = (...a) => console.log("[" + now() + "]", ...a);

function checkConfig() {
  const urlOk =
    config.SUPABASE_URL.startsWith("https://") ||
    config.SUPABASE_URL.startsWith("http://localhost"); // 允许本地自测
  if (
    !urlOk ||
    !config.SUPABASE_SERVICE_KEY ||
    config.SUPABASE_SERVICE_KEY.startsWith("YOUR-")
  ) {
    console.error(
      "缺少配置：请设置环境变量 SUPABASE_URL 与 SUPABASE_SERVICE_KEY\n" +
        "本地可写入 .env 后用 node --env-file=.env 启动；GitHub Actions 请在 Secrets 中配置。"
    );
    process.exit(1);
  }
}

/* ---------------- 通用 HTTP ---------------- */
async function httpGet(url, headers = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA, ...headers },
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 行情源 1：腾讯（默认，实测最稳） ----------------
   请求 https://qt.gtimg.cn/q=usCMI
   返回体按 ~ 分隔，下标 3 = 当前价，下标 30 = 行情时间 */
async function fetchPriceTencent(ticker) {
  const market = config.MARKET || "us";
  const text = await httpGet("https://qt.gtimg.cn/q=" + market + encodeURIComponent(ticker));
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) throw new Error("腾讯响应为空（可能被限流或代码不存在）");
  const f = m[1].split("~");
  const price = parseFloat(f[3]);
  if (!isFinite(price) || price <= 0) throw new Error("腾讯价格解析失败");
  return price;
}

/* ---------------- 行情源 2：新浪（需 Referer） ----------------
   请求 https://hq.sinajs.cn/list=gb_cmi，返回按 , 分隔，下标 1 = 当前价 */
async function fetchPriceSina(ticker) {
  const market = config.MARKET === "us" ? "gb" : config.MARKET; // 美股新浪前缀是 gb_
  const text = await httpGet(
    "https://hq.sinajs.cn/list=" + market + "_" + ticker.toLowerCase(),
    { Referer: "https://finance.sina.com.cn" }
  );
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) throw new Error("新浪响应为空");
  const f = m[1].split(",");
  const price = parseFloat(f[1]);
  if (!isFinite(price) || price <= 0) throw new Error("新浪价格解析失败");
  return price;
}

/* ---------------- 行情源 3：Stooq（CSV，无需 key） ----------------
   请求 https://stooq.com/q/l/?s=cmi.us&f=sd2t2ohlcv&h&e=csv
   CSV 列：Symbol,Date,Time,Open,High,Low,Close,Volume —— 取 Close(下标 6) */
async function fetchPriceStooq(ticker) {
  const suffixMap = { us: ".us", hk: ".hk", sh: ".cn", sz: ".cn" };
  const suffix = suffixMap[config.MARKET] || ".us";
  const text = await httpGet(
    "https://stooq.com/q/l/?s=" + encodeURIComponent(ticker.toLowerCase() + suffix) +
      "&f=sd2t2ohlcv&h&e=csv"
  );
  const line = text.trim().split("\n")[1];
  if (!line) throw new Error("Stooq 无数据");
  const price = parseFloat(line.split(",")[6]);
  if (!isFinite(price) || price <= 0) throw new Error("Stooq 价格解析失败");
  return price;
}

/* ---------------- 行情源 4：Yahoo（海外环境优先） ---------------- */
async function fetchPriceYahoo(ticker) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastErr = null;
  for (const host of hosts) {
    try {
      const text = await httpGet(
        "https://" + host + "/v8/finance/chart/" + encodeURIComponent(ticker) +
          "?interval=1d&range=1d"
      );
      const data = JSON.parse(text);
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price == null) throw new Error("Yahoo 响应中无 regularMarketPrice");
      return price;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Yahoo 拉取失败");
}

const SOURCES = {
  tencent: fetchPriceTencent,
  sina: fetchPriceSina,
  stooq: fetchPriceStooq,
  yahoo: fetchPriceYahoo,
};
const AUTO_ORDER = ["tencent", "sina", "stooq", "yahoo"];

/** 按配置取价；auto 模式下逐个源降级，全部失败才抛错 */
async function fetchPrice(ticker) {
  const order =
    config.PRICE_SOURCE === "auto"
      ? AUTO_ORDER
      : [String(config.PRICE_SOURCE).toLowerCase()];

  let lastErr = null;
  for (const name of order) {
    const fn = SOURCES[name];
    if (!fn) continue;
    try {
      const p = await fn(ticker);
      return { price: p, source: name };
    } catch (e) {
      lastErr = e;
      log("  ↳", ticker, name, "失败：" + e.message);
    }
  }
  throw lastErr || new Error("不支持的 PRICE_SOURCE：" + config.PRICE_SOURCE);
}

/* ---------------- Supabase ---------------- */
function sbHeaders(extra = {}) {
  return {
    apikey: config.SUPABASE_SERVICE_KEY,
    Authorization: "Bearer " + config.SUPABASE_SERVICE_KEY,
    ...extra,
  };
}

async function listTickers() {
  const url =
    config.SUPABASE_URL + "/rest/v1/" + config.STOCKS_TABLE + "?select=ticker";
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) {
    throw new Error("读取股票列表失败：" + (await r.text()).slice(0, 300));
  }
  return r.json();
}

async function writePrice(ticker, price) {
  const url =
    config.SUPABASE_URL +
    "/rest/v1/" +
    config.STOCKS_TABLE +
    "?ticker=eq." +
    encodeURIComponent(ticker);
  const r = await fetch(url, {
    method: "PATCH",
    headers: sbHeaders({
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    }),
    body: JSON.stringify({ realtime_price: price, update_time: now() }),
  });
  if (!r.ok) throw new Error("回写失败 " + r.status + " " + (await r.text()).slice(0, 200));
}

/** 保活：往 heartbeat 表写一行（表不存在时静默跳过，不影响主流程） */
async function heartbeat() {
  if (!config.HEARTBEAT_TABLE) return false;
  const url = config.SUPABASE_URL + "/rest/v1/" + config.HEARTBEAT_TABLE;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: sbHeaders({
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify([{ id: 1, last_seen: now() }]),
    });
    if (!r.ok) return false;
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  checkConfig();
  log("行情源模式：" + config.PRICE_SOURCE + "，市场：" + config.MARKET);

  const rows = await listTickers(); // 这一步本身就是一次数据库活动
  if (!rows || rows.length === 0) {
    log("⚠ 表 " + config.STOCKS_TABLE + " 为空，仅执行保活");
    const ok = await heartbeat();
    log(ok ? "✔ 保活写入成功" : "· 保活表不可用（可忽略，查询本身已产生活动）");
    return { ok: 0, fail: 0, empty: true };
  }

  log("共 " + rows.length + " 只股票，开始更新…");
  let ok = 0;
  let fail = 0;
  const failed = [];

  for (const row of rows) {
    const t = row.ticker;
    let done = false;
    for (let attempt = 1; attempt <= config.MAX_RETRY && !done; attempt++) {
      try {
        const { price, source } = await fetchPrice(t);
        await writePrice(t, price);
        ok++;
        done = true;
        log("✔", t, price, "(" + source + ")");
      } catch (e) {
        if (attempt === config.MAX_RETRY) {
          fail++;
          failed.push({ ticker: t, error: e.message });
          console.error("✘", t, e.message);
        } else {
          await sleep(1000 * attempt);
        }
      }
    }
    await sleep(config.REQUEST_DELAY_MS);
  }

  await heartbeat(); // 收尾再打一次活动点
  log("更新完成：成功 " + ok + "，失败 " + fail);
  if (failed.length) {
    console.error("失败清单：", JSON.stringify(failed, null, 2));
  }

  // GitHub Actions 作业摘要
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = require("fs");
    const md = [
      "## 价格更新结果",
      "",
      "- 时间：" + now(),
      "- 行情源模式：`" + config.PRICE_SOURCE + "`",
      "- 成功：" + ok + " / 失败：" + fail,
      "",
      failed.length
        ? "### 失败清单\n" + failed.map((f) => "- `" + f.ticker + "`： " + f.error).join("\n")
        : "✅ 全部更新成功",
    ].join("\n");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }

  return { ok, fail, failed };
}

checkConfig();
main()
  .then((r) => {
    if (r && r.fail > 0) process.exitCode = 1; // 部分失败也标记，便于在 Actions 里发现
  })
  .catch((e) => {
    console.error("脚本异常：", e.message);
    process.exitCode = 1;
  });
