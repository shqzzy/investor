/* =====================================================
   每日价格更新 + Supabase 保活（update_prices.js）v1.1
   -----------------------------------------------------
   v1.1 修复（针对首轮运行 106 成功 / 2 失败 429）：
     1. 429 / 403 限流感知：命中后该行情源进入 60s 冷却，并做长退避重试
     2. 容忍少量失败：失败率低于 MAX_FAIL_RATIO 时不再 exit 1，避免误报红叉
     3. 支持 TICKER_ALIASES：给 BRKB 这类特殊代码配别名（BRK-B / BRK.B）
     4. 请求间隔加随机抖动，避免整齐节奏被识别为爬虫

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
const jitter = (ms) => ms + Math.floor(Math.random() * 500);

function checkConfig() {
  const urlOk =
    config.SUPABASE_URL.startsWith("https://") ||
    config.SUPABASE_URL.startsWith("http://localhost"); // 允许本地自测
  if (!urlOk || !config.SUPABASE_SERVICE_KEY || config.SUPABASE_SERVICE_KEY.startsWith("YOUR-")) {
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
    if (!resp.ok) {
      const err = new Error("HTTP " + resp.status);
      // 429=限流 403=被拒（海外 IP 常见），都需要退避而不是立刻换源猛打
      if (resp.status === 429 || resp.status === 403) err.rateLimited = true;
      throw err;
    }
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 行情源 1：腾讯（默认，实测最稳） ---------------- */
async function fetchPriceTencent(ticker) {
  const market = config.MARKET || "us";
  const text = await httpGet("https://qt.gtimg.cn/q=" + market + encodeURIComponent(ticker));
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) throw new Error("腾讯响应为空（代码不存在或被限流）");
  const f = m[1].split("~");
  const price = parseFloat(f[3]);
  if (!isFinite(price) || price <= 0) throw new Error("腾讯价格解析失败");
  return price;
}

/* ---------------- 行情源 2：新浪（需 Referer） ---------------- */
async function fetchPriceSina(ticker) {
  const market = config.MARKET === "us" ? "gb" : config.MARKET;
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

/* ---------------- 行情源 3：Stooq（CSV） ---------------- */
// Stooq 用后缀区分交易所，和 Yahoo 的写法不同，需要转换
// Yahoo: WSP.TO / SHOP.TO / RY.TO   → Stooq: wsp.ca ...
const STOOQ_SUFFIX = {
  ".to": ".ca", // 多伦多 TSX
  ".v": ".ca", // TSX Venture
  ".hk": ".hk",
  ".us": ".us",
  ".l": ".uk",
  ".de": ".de",
  ".pa": ".fr",
  ".t": ".jp",
};

function stooqSymbol(ticker) {
  const t = ticker.toLowerCase();
  const dot = t.lastIndexOf(".");
  if (dot > 0) {
    const suf = t.slice(dot);
    if (STOOQ_SUFFIX[suf]) return t.slice(0, dot) + STOOQ_SUFFIX[suf];
    return t;
  }
  const marketSuffix = { us: ".us", hk: ".hk", sh: ".cn", sz: ".cn" };
  return t + (marketSuffix[config.MARKET] || ".us");
}

async function fetchPriceStooq(ticker) {
  const text = await httpGet(
    "https://stooq.com/q/l/?s=" + encodeURIComponent(stooqSymbol(ticker)) +
      "&f=sd2t2ohlcv&h&e=csv"
  );
  const line = text.trim().split("\n")[1];
  if (!line) throw new Error("Stooq 无数据");
  const price = parseFloat(line.split(",")[6]);
  if (!isFinite(price) || price <= 0) throw new Error("Stooq 价格解析失败");
  return price;
}

/* ---------------- 行情源 4：Yahoo（唯一覆盖加拿大/欧洲等国际市场的源） ----------------
   Yahoo 对机房 IP 会返回 429，所以这里准备两个端点：
     · v8/finance/chart  常规行情接口
     · v7/finance/spark  备用接口（限流策略不同，有时能救回来） */
async function fetchPriceYahoo(ticker) {
  const sym = encodeURIComponent(ticker);
  const endpoints = [
    (h) => "https://" + h + "/v8/finance/chart/" + sym + "?interval=1d&range=1d",
    (h) => "https://" + h + "/v7/finance/spark?symbols=" + sym + "&range=1d&interval=1d",
  ];
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

  let lastErr = null;
  for (const makeUrl of endpoints) {
    for (const host of hosts) {
      try {
        const text = await httpGet(makeUrl(host), {
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
        });
        const data = JSON.parse(text);
        const price =
          data?.chart?.result?.[0]?.meta?.regularMarketPrice ??
          data?.spark?.result?.[0]?.response?.[0]?.meta?.regularMarketPrice;
        if (price == null) throw new Error("Yahoo 响应中无价格字段");
        return price;
      } catch (e) {
        lastErr = e;
      }
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
const COOLDOWN_MS = 30000; // 某源被限流后的冷却时间

/** 行情源冷却表：避免被限流的源在短时间内被反复调用 */
const cooldownUntil = new Map();
const isCooling = (name) => (cooldownUntil.get(name) || 0) > Date.now();
const clearCooldown = () => cooldownUntil.clear();

/**
 * 解析某只股票的"查询方案"列表
 * 返回 [{ code, sources }]：
 *   · 无映射 → 用原代码 + 默认源顺序
 *   · 数组映射 → 逐个代码 + 默认源顺序
 *   · 对象映射 → 指定代码 + 指定源（用于加拿大等非美股市场）
 */
function variantsOf(ticker) {
  const alias = config.TICKER_ALIASES[ticker.toUpperCase()];
  if (alias && !Array.isArray(alias) && typeof alias === "object") {
    return [{ code: alias.symbol || ticker, sources: alias.sources }];
  }
  const codes = [ticker];
  if (Array.isArray(alias)) codes.push(...alias);
  else if (typeof alias === "string" && alias) codes.push(alias);
  return [...new Set(codes)].map((code) => ({ code }));
}

/** 按配置取价：auto 模式逐个源降级；全部失败才抛错 */
async function fetchPrice(ticker, ignoreCooldown = false) {
  const sourceOrder =
    config.PRICE_SOURCE === "auto"
      ? AUTO_ORDER
      : [String(config.PRICE_SOURCE).toLowerCase()];

  let lastErr = null;
  let sawRateLimit = false;
  let attempted = 0;

  for (const v of variantsOf(ticker)) {
    const code = v.code;
    const order = v.sources || sourceOrder;
    for (const name of order) {
      const fn = SOURCES[name];
      if (!fn) continue;
      if (!ignoreCooldown && isCooling(name)) {
        log("  ↳", code, name, "冷却中，跳过");
        continue;
      }
      attempted++;
      try {
        const price = await fn(code);
        return { price, source: name, code };
      } catch (e) {
        lastErr = e;
        if (e.rateLimited) {
          sawRateLimit = true;
          cooldownUntil.set(name, Date.now() + COOLDOWN_MS);
        }
        log("  ↳", code, name, "失败：" + e.message);
      }
    }
  }

  // 该股票所有可用源都还在冷却 → 清掉冷却再试一轮，避免被别的股票连累
  if (attempted === 0 && !ignoreCooldown) {
    log("  ⟳", ticker, "所有源均处于冷却，清除冷却后重试");
    clearCooldown();
    return fetchPrice(ticker, true);
  }

  if (lastErr && sawRateLimit) lastErr.rateLimited = true;
  throw (
    lastErr ||
    new Error("无可用行情源（PRICE_SOURCE=" + config.PRICE_SOURCE + "）")
  );
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
  const url = config.SUPABASE_URL + "/rest/v1/" + config.STOCKS_TABLE + "?select=ticker";
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error("读取股票列表失败：" + (await r.text()).slice(0, 300));
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

/** 保活：往 heartbeat 表写一行（表不存在时静默跳过） */
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
    return r.ok;
  } catch {
    return false;
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  checkConfig();
  log("行情源模式：" + config.PRICE_SOURCE + "，市场：" + config.MARKET +
      "，失败容忍率：" + (config.MAX_FAIL_RATIO * 100).toFixed(0) + "%");

  const rows = await listTickers(); // 这一步本身就是一次数据库活动
  if (!rows || rows.length === 0) {
    log("⚠ 表 " + config.STOCKS_TABLE + " 为空，仅执行保活");
    const ok = await heartbeat();
    log(ok ? "✔ 保活写入成功" : "· 保活表不可用（可忽略，查询本身已产生活动）");
    return { ok: 0, fail: 0, empty: true };
  }

  log("共 " + rows.length + " 只股票，开始更新…");
  let ok = 0;
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
          failed.push({ ticker: t, error: e.message });
          console.error("✘", t, e.message);
        } else {
          // 限流要长退避，普通错误短退避
          const backoff = e.rateLimited ? 20000 * attempt : 1200 * attempt;
          log("  ⟳", t, "第 " + attempt + " 次失败，" + (backoff / 1000) + "s 后重试");
          await sleep(backoff);
        }
      }
    }
    await sleep(jitter(config.REQUEST_DELAY_MS));
  }

  await heartbeat(); // 收尾再打一次活动点

  const total = rows.length;
  const fail = failed.length;
  const ratio = total ? fail / total : 0;
  log("更新完成：成功 " + ok + "，失败 " + fail + "（失败率 " + (ratio * 100).toFixed(1) + "%）");
  if (failed.length) console.error("失败清单：", JSON.stringify(failed, null, 2));

  // 失败率在容忍范围内 → 视为成功，不标红（保活目的已达成）
  const tolerated = ok > 0 && ratio <= config.MAX_FAIL_RATIO;
  if (tolerated) log("⚠ 少量失败在容忍范围内，按成功处理");

  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = require("fs");
    const md = [
      "## 价格更新结果",
      "",
      "- 时间：" + now(),
      "- 行情源模式：`" + config.PRICE_SOURCE + "`，市场：`" + config.MARKET + "`",
      "- 成功：" + ok + " / 失败：" + fail + "（失败率 " + (ratio * 100).toFixed(1) + "%）",
      "",
      failed.length
        ? "### 失败清单\n" + failed.map((f) => "- `" + f.ticker + "`： " + f.error).join("\n")
        : "✅ 全部更新成功",
    ].join("\n");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }

  return { ok, fail, ratio, tolerated };
}

checkConfig();
main()
  .then((r) => {
    // 只有"全军覆没"或失败率超阈值才标红
    if (r && !r.empty && !r.tolerated) process.exitCode = 1;
  })
  .catch((e) => {
    console.error("脚本异常：", e.message);
    process.exitCode = 1;
  });
