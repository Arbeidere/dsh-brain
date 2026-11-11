import { DatabaseSync } from 'node:sqlite'
import { apply } from '../index.js'

const DB = 'D:\\dsh-output\\tools\\dsh-brain\\test4.db'
const DAY = 86400000

const tools = new Map()
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
  effect: (fn) => fn(),
  on: () => () => {},
  logger: { info: () => {}, warn: console.warn, debug: () => {} },
}
apply(ctx, { dbPath: DB, capture: false, prime: false, flashbackChance: 1 })

const call = async (n, a) => {
  const t = tools.get(n)
  const v = await t.execute(a ?? {}, {})
  console.log(`\n== ${n} ==\n` + t.output.render(a ?? {}, v).map((b) => b.text).join('\n'))
  return v
}

// 先铺够"底噪"：库要有一定规模，稀有线索才稀有
const noise = [
  '今天调试了 CAD 导出，STEP 文件里面有重复的体',
  '用户让我画一张架构图，深色背景',
  '这个仓库的 pnpm-lock 里有重复的 key',
  '周报里写了三条进度：调研、设计、实现',
  '测试一下 brain_stats 的输出格式',
  '把临时文件清理掉，别留在 C 盘',
  '聊天用的主题是 dark，字号正常',
  '导出目录统一在 dsh-output 下面',
  '跑了一遍 node --check 确认语法没问题',
  '会话的 cwd 是 default-workspace',
  '今天写了一版 Python 画图的脚本',
  '又把 cordis.patch.yml 复核了一遍',
]
for (const text of noise) await call('brain_remember', { text, kind: 'episodic', importance: 0.3 })

// 两条"童年"式的旧记忆：细节具体、但一点也不重要 —— 正是会被忽然想起来的类型
await call('brain_remember', { text: '小学操场边上有棵老槐树，五月开花的时候整条巷子都是甜的', kind: 'episodic', importance: 0.25 })
await call('brain_remember', { text: '外婆家的老式挂钟整点会敲，声音有点闷，像从墙里面传出来', kind: 'episodic', importance: 0.2 })

// 拨回 300 天前；槐树那条进入沉睡（"早就想不起来"）；先写一次 last_sleep 免得自动睡眠把它们清掉
const raw = new DatabaseSync(DB)
const old = Date.now() - 300 * DAY
raw.prepare("UPDATE engrams SET created_at = ? WHERE text LIKE '%老槐树%' OR text LIKE '%挂钟%'").run(old)
raw.prepare("UPDATE engrams SET state = 'dormant' WHERE text LIKE '%老槐树%'").run()
raw.prepare("INSERT INTO meta (k, v) VALUES ('last_sleep', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(Date.now()))
raw.close()

console.log('\n—— 现在的库 ——')
await call('brain_stats', {})

// focus：按相关度+强度找，睡着的旧事不该被翻出来
await call('brain_recall', { query: '巷子里那股甜味是什么', limit: 3 })

// flashback：被稀有线索勾出来，哪怕它已经沉睡
await call('brain_recall', { query: '巷子里那股甜味是什么', mode: 'flashback', limit: 2 })

// 唤醒之后它应该重新 active，强度回升
const after = new DatabaseSync(DB)
const row = after.prepare("SELECT text, state, v0, access_count FROM engrams WHERE text LIKE '%老槐树%'").get()
console.log('\n老槐树那条现在的状态：', row ? `${row.state} v0=${row.v0.toFixed(3)} access=${row.access_count}` : '（不见了）')
after.close()
