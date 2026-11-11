import { DatabaseSync } from 'node:sqlite'
import { apply } from '../index.js'

const DB = 'D:\\dsh-output\\tools\\dsh-brain\\test2.db'
const DAY = 86400000
const now = Date.now()

// 预置三条"很久以前"的记忆：一条该忘、一条该被巩固、一条钉在前额叶
const seed = new DatabaseSync(DB)
seed.exec(`
  CREATE TABLE IF NOT EXISTS engrams (id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, region TEXT NOT NULL,
    importance REAL NOT NULL, v0 REAL NOT NULL, created_at INTEGER NOT NULL, last_access INTEGER NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0, tokcount INTEGER NOT NULL DEFAULT 0, scope TEXT, session_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'manual', state TEXT NOT NULL DEFAULT 'active', hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tokens (engram_id TEXT NOT NULL, token TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`)
const ins = seed.prepare(`INSERT OR REPLACE INTO engrams
  (id,text,kind,region,importance,v0,created_at,last_access,access_count,tokcount,scope,session_id,tags,source,state,hash)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const insTok = seed.prepare('INSERT INTO tokens (engram_id, token) VALUES (?, ?)')
const rows = [
  ['old-weak', '随口提了一句今天有点困，可能因为昨晚熬夜看视频', 'episodic', 'hippocampus', 0.3, 0.6, now - 40 * DAY, now - 40 * DAY, 0],
  ['old-used', '用户要求所有交付物必须落在 D 盘输出目录，这是硬约束', 'episodic', 'hippocampus', 0.6, 0.8, now - 20 * DAY, now - 20 * DAY, 4],
  ['pin', '当前任务：实现仿人脑记忆插件，四个工作池共用', 'working', 'pfc', 0.9, 0.95, now - 3 * DAY, now - 3 * DAY, 2],
]
for (const [id, text, kind, region, imp, v0, created, access, count] of rows) {
  ins.run(id, text, kind, region, imp, v0, created, access, count, 10, 'C:\\w', null, '[]', 'manual', 'active', id)
  for (const t of text.replace(/[^\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean)) {
    for (let i = 0; i + 1 < t.length; i += 1) insTok.run(id, 'c:' + t.slice(i, i + 2))
  }
}
seed.close()

const tools = new Map()
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
  effect: (fn) => fn(),
  on: () => () => {},
  logger: { info: () => {}, warn: console.warn, debug: () => {} },
}
apply(ctx, { dbPath: DB, capture: false, prime: false })
const call = async (n, a) => {
  const t = tools.get(n)
  const v = await t.execute(a ?? {}, {})
  console.log(`\n== ${n} ==\n` + t.output.render(a ?? {}, v).map((b) => b.text).join('\n'))
  return v
}
await call('brain_stats', {})
await call('brain_sleep', {})
await call('brain_stats', {})
const after = new DatabaseSync(DB)
console.log('\nregion/state after sleep:')
for (const r of after.prepare('SELECT id, region, kind, state, access_count FROM engrams').all()) {
  console.log(' ', r.id, r.region, r.kind, r.state, 'access=' + r.access_count)
}
after.close()
