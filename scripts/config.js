/* =====================================================
   config.js —— 配置（本地 / GitHub Actions 通用）
   -----------------------------------------------------
   所有敏感信息都从环境变量读取，不再硬编码：

     SUPABASE_URL            https://xxxx.supabase.co
     SUPABASE_SERVICE_KEY    service_role key（不要提交到仓库！）
     PRICE_SOURCE            auto | tencent | sina | yahoo | stooq
     MARKET                  us（美股）| hk（港股）| sh / sz（A股）
     REQUEST_DELAY_MS        每只股票之间的间隔（毫秒）
     HTTP_TIMEOUT_MS         单次行情请求超时（毫秒）
     MAX_RETRY               单只股票最多尝试次数
     STOCKS_TABLE            表名，默认 stocks

   本地运行：node --env-file=.env scripts/update_prices.js （Node 20.6+）
   GitHub Actions：由 workflow 的 env 注入，无需修改本文件。
   ===================================================== */
"use strict";

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

module.exports = {
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || "",

  // auto = 按 tencent -> sina -> stooq -> yahoo 顺序自动降级
  PRICE_SOURCE: process.env.PRICE_SOURCE || "auto",

  // 腾讯用前缀（us/hk/sh/sz），新浪美股用 gb，stooq 用后缀（.us/.hk/.cn）
  MARKET: process.env.MARKET || "us",

  REQUEST_DELAY_MS: num(process.env.REQUEST_DELAY_MS, 2500),
  HTTP_TIMEOUT_MS: num(process.env.HTTP_TIMEOUT_MS, 15000),
  MAX_RETRY: num(process.env.MAX_RETRY, 3),

  // 失败率不超过该比例就按成功处理（避免个别股票限流导致整个 workflow 标红）
  MAX_FAIL_RATIO: num(process.env.MAX_FAIL_RATIO, 0.1), // 默认 10%

  // 特殊代码映射：部分股票在某些行情源里写法不同，或只有特定源才覆盖
  //
  // 形式 1（数组）：只是换个写法，所有源都按顺序试
  //   "BRKB": ["BRK.B"]
  //
  // 形式 2（对象）：指定查询符号 + 只用这些源（用于非美股市场）
  //   "WSP": { "symbol": "WSP.TO", "sources": ["yahoo", "stooq"] }
  //
  // 内置已覆盖两类典型情况：
  //   · 伯克希尔 B 股：腾讯/新浪必须写成 BRK.B，写 BRKB 查不到
  //   · WSP Global（加拿大多伦多 TSX）：腾讯和新浪都不覆盖加拿大市场，
  //     必须用 Yahoo 风格的 WSP.TO
  //
  // 需要追加时用环境变量 TICKER_ALIASES（JSON），会与内置值合并：
  //   TICKER_ALIASES={"RY":{"symbol":"RY.TO","sources":["yahoo"]}}
  TICKER_ALIASES: (() => {
    const DEFAULT = {
      BRKB: ["BRK.B"],
      BRKA: ["BRK.A"],
      BFB: ["BF.B"],
      BFA: ["BF.A"],
      // 加拿大多伦多交易所（TSX）
      WSP: { symbol: "WSP.TO", sources: ["yahoo", "stooq"] },
    };
    try {
      return { ...DEFAULT, ...JSON.parse(process.env.TICKER_ALIASES || "{}") };
    } catch {
      return DEFAULT;
    }
  })(),

  STOCKS_TABLE: process.env.STOCKS_TABLE || "stocks",
  HEARTBEAT_TABLE: process.env.HEARTBEAT_TABLE || "heartbeat",
};
