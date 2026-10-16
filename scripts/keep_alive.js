/* =====================================================
   keep_alive.js —— 纯保活脚本（可选，但在 Actions 里建议先跑一次）
   -----------------------------------------------------
   做三件事，任意一件成功即视为保活成功：
     1) 查询 stocks 表（读活动）
     2) 调用 Storage API 列桶（PostgREST 之外的另一条服务链路）
     3) 写 heartbeat 表（写活动，最保险）

   用法：node scripts/keep_alive.js
   ===================================================== */
"use strict";

const config = require("./config");
const now = () => new Date().toISOString();
const log = (...a) => console.log("[" + now() + "]", ...a);

function headers(extra = {}) {
  return {
    apikey: config.SUPABASE_SERVICE_KEY,
    Authorization: "Bearer " + config.SUPABASE_SERVICE_KEY,
    ...extra,
  };
}

async function op(name, fn) {
  try {
    const r = await fn();
    log("✔", name, r || "");
    return true;
  } catch (e) {
    log("✘", name, e.message);
    return false;
  }
}

async function main() {
  const urlOk =
    config.SUPABASE_URL.startsWith("https://") ||
    config.SUPABASE_URL.startsWith("http://localhost");
  if (!urlOk || !config.SUPABASE_SERVICE_KEY) {
    console.error("缺少 SUPABASE_URL / SUPABASE_SERVICE_KEY 环境变量");
    process.exit(1);
  }
  log("开始保活…");

  const results = [];

  results.push(
    await op("数据库查询", async () => {
      const r = await fetch(
        config.SUPABASE_URL + "/rest/v1/" + config.STOCKS_TABLE + "?select=ticker&limit=1",
        { headers: headers() }
      );
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      return "返回 " + (Array.isArray(j) ? j.length : 0) + " 行";
    })
  );

  results.push(
    await op("Storage API", async () => {
      const r = await fetch(config.SUPABASE_URL + "/storage/v1/bucket", { headers: headers() });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      return "buckets: " + (Array.isArray(j) ? j.length : 0);
    })
  );

  results.push(
    await op("heartbeat 写入", async () => {
      const r = await fetch(config.SUPABASE_URL + "/rest/v1/" + config.HEARTBEAT_TABLE, {
        method: "POST",
        headers: headers({
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        }),
        body: JSON.stringify([{ id: 1, last_seen: now() }]),
      });
      if (!r.ok) throw new Error("HTTP " + r.status + "（表不存在？见 README 建表 SQL）");
      return "ok";
    })
  );

  const okCount = results.filter(Boolean).length;
  log("保活完成：" + okCount + "/" + results.length);
  if (okCount === 0) process.exit(1);
}

main().catch((e) => {
  console.error("保活脚本异常：", e.message);
  process.exit(1);
});
