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

  REQUEST_DELAY_MS: num(process.env.REQUEST_DELAY_MS, 1500),
  HTTP_TIMEOUT_MS: num(process.env.HTTP_TIMEOUT_MS, 15000),
  MAX_RETRY: num(process.env.MAX_RETRY, 3),

  STOCKS_TABLE: process.env.STOCKS_TABLE || "stocks",
  HEARTBEAT_TABLE: process.env.HEARTBEAT_TABLE || "heartbeat",
};
