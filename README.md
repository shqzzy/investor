# Supabase 每日自动更新价格 + 防暂停（GitHub Actions 版）

原理一句话：**把本地 `node update_prices.js` 搬到 GitHub Actions 上定时跑**。
它每天两次访问 Supabase（读股票表 + 回写价格 + 写 heartbeat），这些请求本身就是"数据库活动"，
Supabase 免费项目 7 天内只要有活动就不会被暂停。

> GitHub Pages（`shqzzy.github.io`）只是静态托管，不会执行脚本；
> 真正干活的是 **GitHub Actions**。
> Actions 和 Pages 没有任何绑定关系——**任意仓库都能跑**，所以放在独立的 `investor`
> 仓库完全没问题，而且比混在 Pages 仓库里更干净（见下方"为什么推荐独立仓库"）。

---

## 〇、为什么推荐放 `investor` 而不是 Pages 仓库

| 对比项 | 放 `investor`（推荐） | 放 `shqzzy.github.io` |
|---|---|---|
| 跑定时任务 | ✅ 完全一样，Actions 不挑仓库 | ✅ 能跑 |
| 自动 commit 的影响 | 只污染这个工具仓库 | 每次都触发 **Pages 重新构建**站点，白等 1～2 分钟，还会在贡献图里刷一堆 bot 提交 |
| 站点安全性 | Pages 仓库不用放任何密钥相关文件 | 密钥相关 workflow 和站点源码混在一起 |
| 维护 | 独立、清爽 | 站点文件和脚本纠缠 |

结论：**就放 `investor`**。你的 Pages 站点保持纯净，定时任务在另一个仓库默默跑。

---

## 一、目录结构（按这个位置放文件）

```
investor/
├── .github/
│   ├── workflows/
│   │   └── daily-price-update.yml   ← 定时任务的"闹钟"
│   └── runlog/
│       └── last-run.txt             ← 脚本自动维护，不用手动建
└── scripts/
    ├── config.js          ← 全部改读环境变量
    ├── update_prices.js   ← 主脚本（已改造）
    └── keep_alive.js      ← 纯保活脚本（兜底）
```

根目录还需要（可选但推荐）：`package.json`、`.gitignore`、`.env.example`。

---

## 二、准备 Supabase 的两个值

1. 打开 Supabase Dashboard → 你的项目 → **Project Settings → API**
2. 复制：
   - **Project URL**：形如 `https://abcdefgh.supabase.co` → 这是 `SUPABASE_URL`
   - **service_role key**（`service_role` 那一行，不是 anon）→ 这是 `SUPABASE_SERVICE_KEY`
     - 它绕过 RLS，权限很大，**只放进 GitHub Secrets，永远不要写进代码或提交到仓库**

⚠️ 安全提醒：如果仓库是公开的，Secrets 本身不会被别人看到（日志里也会自动打成 `***`），
但你自己也不要在 issue、README、commit message 里贴出来。最稳妥是**把仓库设为 Private**。

---

## 三、（推荐）建一张 heartbeat 表

在 Supabase 左侧 **SQL Editor** 里执行一次：

```sql
create table if not exists heartbeat (
  id         int primary key,
  last_seen  timestamptz not null
);

-- 让脚本能写入（service_role 本就绕过 RLS，这里给个保险）
alter table heartbeat enable row level security;
```

再确认 `stocks` 表里有这三个字段，并且 `ticker` 最好唯一（否则 PATCH 会一次改多行）：

```sql
-- 如已存在可跳过；ticker 建议加唯一约束
alter table stocks add column if not exists realtime_price numeric;
alter table stocks add column if not exists update_time timestamptz;
```

> 没有 heartbeat 表也能跑：脚本会静默跳过这一步，靠"查询 + 回写价格"保活。
> 但空表/行情全失败时，heartbeat 是最后一道保险，建议建上。

---

## 四、上传文件到 `investor` 仓库

你的 `investor` 仓库现在只有 `LICENSE` 和 `stackbit.config.ts`，是干净的，两种上传方式任选：

**方式 A：网页上传（不用装 Git，推荐）**

1. 打开 `https://github.com/shqzzy/investor`
2. 点 **Add file → Create new file**，文件名框里直接**把路径一起写上**，
   GitHub 会自动建目录，例如：
   - `.github/workflows/daily-price-update.yml`
   - `scripts/config.js`
   - `scripts/update_prices.js`
   - `scripts/keep_alive.js`
3. 每个文件把内容粘进去，底部 **Commit changes** → 默认提交到 `main` 分支
4. 重复 4 次即可（`package.json` / `.gitignore` / `.env.example` 可选，不影响运行）

**方式 B：命令行**

```bash
git clone https://github.com/shqzzy/investor.git
cd investor
# 把 .github/ 和 scripts/ 拷进来
git add .github/workflows/daily-price-update.yml scripts/ package.json .gitignore
git commit -m "feat: 定时更新股价并保活 Supabase"
git push origin main
```

> 确认默认分支是 `main`（仓库首页显示的分支名）。如果是别的分支名，workflow 里的
> `Run workflow` 手动触发时选对应分支即可，定时触发不受分支名影响。

⚠️ 仓库是 Public 的：Secrets 不会明文泄露（日志自动打码），但**千万不要**把
`service_role key` 写进任何文件内容里。想更保险的话，把 `investor` 设为 Private——
私有仓库的 Actions 免费额度是每月 2000 分钟，本方案每天跑 2 次、每次约 30 秒，
一个月不到 40 分钟，完全够。

---

## 五、配置 Secrets（关键步骤）

1. 打开 `https://github.com/shqzzy/investor` → **Settings**
2. 左侧 **Secrets and variables → Actions**
3. 点 **New repository secret**，加两个：

| Name | Secret |
|---|---|
| `SUPABASE_URL` | `https://abcdefgh.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `eyJhbGciOi...` |

名字必须和上面**完全一致**（大小写敏感），yml 里是通过 `${{ secrets.SUPABASE_URL }}` 读的。

---

## 六、给 Actions 开写权限（很容易漏的一步）

workflow 最后会自动提交 `last-run.txt`，否则 GitHub 会在仓库 60 天无提交时**自动停用定时任务**。

1. **Settings → Actions → General**
2. 拉到最下面 **Workflow permissions**
3. 选 **Read and write** → Save

如果这一步没做，脚本本身能跑，但最后 `git push` 会报 403，长期下来定时任务会被停用。

---

## 七、手动触发一次，验证是否成功

1. 打开 `https://github.com/shqzzy/investor` → **Actions** 标签
   （如果显示"Workflows aren't being run on this fork"或空白，等 1 分钟刷新一下，
    GitHub 需要几秒识别新上传的 workflow 文件）
2. 左侧点 **Supabase 每日价格更新 & 保活**
3. 右上角 **Run workflow** → 分支选 `main` → 绿色的 **Run workflow**
4. 等 1～2 分钟，点进这次运行看日志，正常应该看到：

```
[2026-10-16T02:36:53Z] 开始保活…
✔ 数据库查询 返回 2 行
✔ Storage API buckets: 0
✔ heartbeat 写入 ok
[2026-10-16T02:36:34Z] 共 2 只股票，开始更新…
✔ CMI 532.73 (tencent)
✔ AAPL 342 (tencent)
更新完成：成功 2，失败 0
```

5. 顺手去 Supabase → **Table Editor → stocks**，确认 `realtime_price`、`update_time` 变了。

---

## 八、定时时间说明（UTC 坑）

GitHub Actions 的 cron **一律用 UTC**，北京时间 = UTC + 8。当前配置：

| cron | 北京时间 | 作用 |
|---|---|---|
| `17 22 * * *` | 06:17 | 美股收盘后（夏令时 04:00 / 冬令时 05:00 收盘），更新当日收盘价 |
| `23 13 * * *` | 21:23 | 二次保活，双保险 |

两个注意点：
- **不要写在整点**（`:00`）。整点任务排队最久，常被延迟 5～30 分钟，所以这里用了 `:17`、`:23`。
- 如果只想保活不想更新，把第二个 cron 保留即可，价格更新失败也不影响保活。

改时间只改 yml 里的两行 cron，push 后自动生效。

---

## 九、本地怎么跑

```bash
cp .env.example .env      # 填入真实值（.env 已在 .gitignore 里，不会被提交）
node --env-file=.env scripts/update_prices.js
node --env-file=.env scripts/keep_alive.js
```

`--env-file` 需要 Node 20.6+；老版本就 `npm i dotenv` 或在命令行前直接写环境变量：

```bash
SUPABASE_URL=xxx SUPABASE_SERVICE_KEY=yyy node scripts/update_prices.js
```

---

## 十、常见问题排查

| 现象 | 原因 / 处理 |
|---|---|
| `缺少配置：请设置环境变量…` | Secrets 名字拼错，或 workflow 里 `env:` 没传；本地则是 `.env` 没加载 |
| `读取股票列表失败：HTTP 401` | key 用错（用了 anon）或 URL 末尾多写了 `/rest/v1`；`SUPABASE_URL` 只填到 `.co` |
| `回写失败 404` | 表名不是 `stocks`，用 Secret `STOCKS_TABLE` 指定 |
| 价格一直是旧值 | 看日志里的源名，全部 `✘` 说明该源在海外 IP 被限流；把 `PRICE_SOURCE` 手动设为 `tencent` 或 `sina` 试 |
| Actions 页面看不到定时任务 | 仓库 60 天无提交会被 GitHub 停用；本方案的自动 commit 就是防这个，确认第六步权限已开 |
| 日志里 git push 403 | 同第六步，Workflow permissions 没改成 Read and write |
| 项目还是被暂停了 | 检查 Actions 最近是否真的成功跑过（红色 = 失败不算足量活动）；也可临时降到每天跑一次但确保成功 |
| Pages 站点经常重新部署 | 放在 `investor` 仓库就不会有这个问题（这也是推荐独立仓库的原因） |
| Actions 页面看不到 workflow | 确认文件在 `.github/workflows/` 下且扩展名是 `.yml`；新上传后等 1 分钟再刷新 |
| `git push` 报分支不存在 | 看仓库首页默认分支名，命令改成对应分支 |

---

## 十一、个别股票失败怎么办（429 / 查不到代码）

首轮运行出现过「成功 106，失败 2：BRKB、WSP，HTTP 429」，排查结论如下：

### 1. 429 多半是"假象"，真正原因是代码写法

脚本在 auto 模式下会依次尝试 tencent → sina → stooq → yahoo，
**最终报出的错误来自最后一个源**，而 Yahoo 对 GitHub 机房 IP 经常返回 429。
所以你看到 `HTTP 429`，往往是因为前面几个源都因为**代码查不到**而失败了。

验证：腾讯对 `usBRKB` 返回空，对 `usBRK.B` 才有数据 →

| 你表里写的 | 正确写法 |
|---|---|
| `BRKB` | `BRK.B` |
| `BRKA` | `BRK.A` |
| `BFB` | `BF.B` |

脚本已内置这些别名（见 `scripts/config.js` 的 `TICKER_ALIASES`），**更新脚本后 BRKB 会自动用 BRK.B 去查**。
如果还有别的特殊代码，加一个 Secret：

| Name | Secret |
|---|---|
| `TICKER_ALIASES` | `{"BRKB":["BRK.B"],"你的代码":["正确写法"]}` |

### 2. WSP 是加拿大多伦多（TSX）股票 —— 已单独处理

腾讯和新浪**都不覆盖加拿大市场**（实测 `caWSP`、`toWSP`、`usWSP.TO`、新浪 `ca_wsp`
全部返回空），所以 WSP 必须走 Yahoo，且代码要带交易所后缀：`WSP.TO`。

v1.2 内置了这个映射：

```js
WSP: { symbol: "WSP.TO", sources: ["yahoo", "stooq"] }
```

含义是：查 WSP 时**直接用 `WSP.TO`，且只走 yahoo / stooq 两个源**（跳过必然失败的腾讯和新浪），
拿到价格后仍按表里的 `WSP` 回写，不影响你的数据。

同时做了三件配套的事：
- **stooq 后缀自动转换**：Yahoo 的 `.TO` → stooq 的 `.ca`（`WSP.TO` → `wsp.ca`）
- **Yahoo 双端点**：`/v8/finance/chart` 失败会自动试 `/v7/finance/spark`，降低 429 影响
- **冷却不再连累别人**：BRKB 触发限流把 yahoo 冷却掉后，轮到 WSP 时发现"所有源都在冷却"，
  会自动清冷却重试，不会因为前面股票的限流而无辜失败

> 如果你后面还加了别的加拿大股（比如 `RY`、`SHOP`、`TD`），加一个 Secret 即可：
> `TICKER_ALIASES` = `{"RY":{"symbol":"RY.TO","sources":["yahoo","stooq"]},"SHOP":{"symbol":"SHOP.TO","sources":["yahoo","stooq"]}}`
>
> 交易所后缀速查：多伦多 `.TO`、TSX Venture `.V`、伦敦 `.L`、巴黎 `.PA`、东京 `.T`、澳洲 `.AX`

**万一 Yahoo 在你的 Actions 上一直 429**（机房 IP 被限流是概率事件）：
WSP 只有 1 只，失败率 1/108 ≈ 0.9%，远低于 10% 阈值，**整体仍是绿色，不影响保活**。
想彻底解决就换带 key 的源，例如 iTick 免费套餐（region=CA 无需信用卡），
拿到 key 后在 Actions 里加 Secret，我再给你加一个 `itick` 行情源。

### 3. 其他股票查不到怎么办

先判断属于哪种情况：

| 现象 | 判断 | 处理 |
|---|---|---|
| 腾讯/新浪返回空，但 Yahoo 能查 | 代码写法问题 | 用 `TICKER_ALIASES` 数组形式换写法 |
| 所有源都空 | 非美股市场（加拿大/欧洲等） | 用对象形式指定 `symbol`（带 `.TO`/`.L` 等后缀）+ `sources:["yahoo","stooq"]` |
| 真的是脏数据 | 表里录错了 | 直接从 `stocks` 表删掉这行 |

### 4. 少量失败不该让 workflow 变红

v1.1 新增 `MAX_FAIL_RATIO`（默认 `0.1`，即 10%）：
失败率在阈值内 → 只打警告，**退出码仍是 0**，Actions 保持绿色；
只有「全部失败」或「失败率超阈值」才标红提醒你。

> 重要：保活在第一步就跑完了，价格更新失败**不影响 Supabase 保活**。

### 5. 真被限流时的缓解

- `REQUEST_DELAY_MS` 已从 1500 提到 2500，并加了随机抖动；
- 命中 429/403 的源会**冷却 30 秒**，不再被反复调用；
- 重试退避按错误类型区分：限流 20s/40s，普通错误 1.2s/2.4s。

---

## 十二、行情源策略（为什么这么改）

Actions 的机器在美国，原来本地能用的源不一定通，所以脚本内置了自动降级：

```
auto → tencent(腾讯 qt.gtimg.cn) → sina → stooq → yahoo
```

- 实测腾讯源对美股（`usCMI`）、港股（`hk00700`）都稳定返回实时价，作为首选；
- 新浪需带 Referer，脚本已内置；
- Stooq / Yahoo 作为海外兜底。
- 想固定某个源：Secrets 里加 `PRICE_SOURCE=tencent`，或在手动触发时下拉选择。

其他可调参数（都是可选 Secret）：

| Name | 默认 | 说明 |
|---|---|---|
| `PRICE_SOURCE` | `auto` | auto / tencent / sina / stooq / yahoo |
| `MARKET` | `us` | us 美股 / hk 港股 / sh / sz A股 |
| `REQUEST_DELAY_MS` | `2500` | 股票少且想更快可降到 1000；被限流就调大 |
| `HTTP_TIMEOUT_MS` | `15000` | 单次请求超时 |
| `MAX_RETRY` | `3` | 单只股票重试次数 |
| `MAX_FAIL_RATIO` | `0.1` | 失败率低于此值按成功处理（0.1=10%） |
| `TICKER_ALIASES` | 内置 | JSON，代码映射；数组=换写法，对象=换符号+限定源，见第十一章 |
| `STOCKS_TABLE` | `stocks` | 表名 |
