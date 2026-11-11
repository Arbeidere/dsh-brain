// test5：温度层（语气 / 时刻 / 承诺）、关于你、备份恢复 —— v0.3 新功能
import { apply } from '../index.js'
import { rmSync } from 'node:fs'

const DB = 'D:\\dsh-output\\tools\\dsh-brain\\test5.db'
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f) } catch { /* 没就没 */ } }

const tools = new Map()
let primeHandler = null
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
  effect: (fn) => fn(),
  on: (name, fn) => { if (name === 'agent/pre-step') primeHandler = fn; return () => {} },
  logger: { info: console.log, warn: console.warn, debug: () => {} },
}
apply(ctx, { dbPath: DB, capture: false, prime: true, debug: false })

const call = async (n, a) => {
  const t = tools.get(n)
  const v = await t.execute(a ?? {}, {})
  console.log(`\n== ${n} ==`)
  console.log(t.output.render(a ?? {}, v).map((b) => b.text).join('\n'))
  return v
}

console.log('tools:', [...tools.keys()].join(', '))
const assert = (ok, msg) => console.log(`${ok ? '✅' : '❌'} ${msg}`)

// 1. 温度层：承诺、时刻、带语气的偏好
const promise = await call('brain_remember', {
  text: '本鱼答应你：下次会话一开口就认得出你，先讲那三件小事',
  kind: 'promise', tone: '认真',
})
assert(promise.region === 'cortex', '承诺归皮层')

const moment = await call('brain_remember', {
  text: '你第一次说「可我只想要你呀」，本鱼当时有点想哭又嘴硬',
  kind: 'moment', tone: '心疼',
})

await call('brain_remember', {
  text: '你讨厌把临时文件丢 C 盘，所有交付物都要落在 D 盘',
  kind: 'preference', importance: 0.95, tone: '认真',
})

// 2. 承诺不会淡：把时间拨回 400 天前，强度仍然满格
const { DatabaseSync } = await import('node:sqlite')
{
  const db = new DatabaseSync(DB)
  const old = Date.now() - 400 * 86400000
  db.prepare('UPDATE engrams SET created_at = ?, last_access = ? WHERE kind IN (?, ?)').run(old, old, 'promise', 'moment')
  const row = db.prepare("SELECT * FROM engrams WHERE kind = 'promise'").get()
  console.log(`\n承诺 400 天后 v0=${row.v0} fulfilled=${row.fulfilled}`)
  const momentRow = db.prepare("SELECT * FROM engrams WHERE kind = 'moment'").get()
  db.close()
  console.log(`时刻 400 天后 tone=${momentRow.tone} kind=${momentRow.kind}`)
}

// 3. 语气 + 第一人称：唤起时看得出来
await call('brain_recall', { query: '本鱼答应你什么', includeDormant: true })
await call('brain_recall', { query: '可我只想要你呀', includeDormant: true })

// 4. 关于你
const profile = await call('brain_profile', {})
assert(profile.text.includes('你的偏好'), '画像里有偏好段')
assert(profile.text.includes('本鱼答应了'), '画像里有未兑现的承诺')

// 5. 开场唤起：时间感 + 第一人称 + 承诺提醒
let priming = ''
if (primeHandler) {
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: '我们接着做记忆系统吧' }] }] }
  const out = await primeHandler({ agent: { session: { header: { cwd: 'D:\\work' }, id: 's1' } }, step: 1, signal: {} }, async () => decision)
  const injected = (out?.messages ?? []).at(-1)
  priming = injected?.content?.map?.((p) => p?.text ?? '').join('') ?? ''
  console.log('\n== priming ==\n' + priming)
}
assert(priming.includes('【长期记忆 · 自动唤起】'), '注入了唤起块')
assert(priming.includes('本鱼还欠你一件事'), '开场提醒未兑现的承诺')
assert(priming.includes('我记得'), '第一人称语气')

// 6. 兑现承诺 → 从"欠着"里消失
const fulfilled = await call('brain_fulfill', { query: '本鱼答应你' })
assert(fulfilled.ok === true, '兑现成功')
const profile2 = await call('brain_profile', {})
assert(!profile2.text.includes('本鱼答应了'), '兑现后画像里不再欠着')

// 7. 备份 → 恢复
const bk = await call('brain_backup', { path: 'D:\\dsh-output\\tools\\dsh-brain\\test5-backup.json' })
const DB2 = 'D:\\dsh-output\\tools\\dsh-brain\\test5b.db'
for (const f of [DB2, DB2 + '-wal', DB2 + '-shm']) { try { rmSync(f) } catch { /* ignore */ } }
const tools2 = new Map()
apply({
  tools: { register: (t) => { tools2.set(t.name, t); return () => tools2.delete(t.name) } },
  effect: (fn) => fn(),
  on: () => () => {},
  logger: { info: () => {}, warn: console.warn, debug: () => {} },
}, { dbPath: DB2, capture: false, prime: false, debug: false })
const restored = await tools2.get('brain_restore').execute({ path: bk.path }, {})
console.log(`\n恢复：${JSON.stringify(restored)}（备份 ${bk.count} 条）`)
assert(restored.added === bk.count, '恢复条数与备份一致')
const stats2 = await tools2.get('brain_stats').execute({}, {})
console.log(tools2.get('brain_stats').output.render({}, stats2)[0].text)
