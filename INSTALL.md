# dsh-brain 安装说明

DeepSeek Harness 的仿人脑记忆插件（海马体 / 前额叶 / 皮层 + 遗忘曲线 + 睡眠整理）。
零第三方依赖：只用 Node 内置的 `node:sqlite`，不需要 API key、不需要构建。

## 安装

### A. 用 DSH 的插件管理（推荐）
```
plugin_manager install_bundle(target="<解压后 dsh-brain 文件夹的绝对路径>")
```
装完重开会话，工具就会出现。

### B. 手动挂进 profile
1. 把文件夹放到任意位置，例如 `D:\dsh-output\tools\dsh-brain\pkg`
2. 在 profile 的 `package.json` 里：
   - `dependencies` 加 `"@local/dsh-brain": "link:<该路径>"`
   - `dsh.profile.bundles` 数组加 `"@local/dsh-brain"`
3. `pnpm install` 后重启 DSH。

## 九个工具

| 工具 | 干什么 |
| --- | --- |
| `brain_remember` | 主动记牢一条（偏好/决定/结论/承诺），可带语气与重要度 |
| `brain_recall` | 按说法找记忆；`mode:"flashback"` 专挑被稀有线索勾出的旧事 |
| `brain_sleep` | 手动跑一次睡眠整理（衰减降级、固化进皮层、融合重复、清理长期不用的） |
| `brain_stats` | 看脑库状态：各脑区条数、平均强度、最近一次整理 |
| `brain_forget` | 删一条（给 id 精确删；给 query 默认只删最相关的一条，`all:true` 才删 5 条） |
| `brain_fulfill` | 把答应过的事标成已完成，不再出现在开场提醒里 |
| `brain_profile` | 看画像：偏好、底线、我们之间的时刻、还欠着的事 |
| `brain_backup` | 整个脑库导出成一个 JSON 文件 |
| `brain_restore` | 从 `brain_backup` 的 JSON 恢复（按内容去重） |

## 配置

`cordis.patch.yml` 里只有一项：

```yaml
config:
  dbPath: 'D:\dsh-output\tools\dsh-brain\brain.db'
```

- 不写 `dbPath` 时：有 D 盘就用 `D:\dsh-output\tools\dsh-brain\brain.db`，没有则退回 `~/.dsh/dsh-brain/brain.db`（跨平台可用）。
- 数据库就是一个 SQLite 文件，复制即备份。
- 其它可调项：`capture` / `prime` / `captureMaxChars` / `primeMaxChars` / `sleepEveryHours` / `flashback` / `flashbackChance` / `warmth` / `debug`。

## 0.1.2 修复记录（来自一次逐行审查）

1. `buildPriming` 现在也会触发 `maybeSleep` —— 长时间只聊天、不调 `brain_recall` 也会整理，海马体不会无限膨胀。
2. `PRAGMA busy_timeout = 5000` —— 四个工作池共用一个库时，写冲突改为等待而不是直接 `SQLITE_BUSY` 丢记忆。
3. `writeEngram` / `sleep` / `forget` 的写操作包进 `BEGIN IMMEDIATE` 事务（`withTx`）—— 不再出现「engrams 有记录、tokens 只写了一半」。
4. 同义词扩展改为**先拍快照、只扩一层**，并做**双向闭合**（搜 file 也能命中「文件」），不再多跳扩散把权重越乘越小。
5. `similarity` 夹到 `[0,1]` —— 原先 IDF 加权分子配原始词数分母，量纲不一致会让单条稀有关系得分 >1，压过强度与重要性。
6. `brain_forget` 给 query 时**默认只删一条**（原先会一次删掉 5 条不可恢复的记忆），要批量得显式 `all:true`。
7. 唤起块截断改为**先裁正文、再拼尾巴提示**，不会再把 `brain_recall` 提示切掉。
8. `sleepEveryHours` 改从 `cfg` 读，去掉模块级全局 `SLEEP_INTERVAL_MS`（多实例会互相覆盖）。
9. `INSTALL.md` 补齐 9 个工具（原来只写了 7 个）。
10. `dbPath` 默认值改为动态探测（无 D 盘时退回用户目录），不再写死 Windows 绝对路径。

## 已知注意

- **package.json 必须是无 BOM 的 UTF-8**，否则加载器 `JSON.parse` 失败、插件被整只跳过。
- 工具输出 schema 里 `type` 只能写单一类型字符串（`["string","null"]` 会让插件激活失败）。
- 宿主没有插件热重载：改完 `index.js` 必须重启 DSH；改坏导致加载失败时插件会被卸载，同样要重启恢复。

## 许可

MIT
