import { apply } from '../index.js'

const tools = new Map()
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
  effect: (fn) => fn(),
  on: () => () => {},
  logger: { info: console.log, warn: console.warn, debug: () => {} },
}
apply(ctx, { dbPath: 'D:\\dsh-output\\tools\\dsh-brain\\test.db', capture: false, prime: false })
console.log('tools:', [...tools.keys()].join(', '))

const call = async (n, a) => {
  const t = tools.get(n)
  const v = await t.execute(a ?? {}, {})
  const blocks = t.output.render(a ?? {}, v)
  console.log(`\n== ${n} ==`)
  console.log(blocks.map((b) => b.text).join('\n'))
  return v
}

await call('brain_remember', { text: '用户偏好：所有生成产物一律放 D 盘 dsh-output，不要堆 C 盘', kind: 'preference', importance: 0.95 })
await call('brain_remember', { text: '已经决定用 SQLite 存记忆，因为 node:sqlite 是内置模块，不用装 better-sqlite3', kind: 'semantic', importance: 0.8 })
await call('brain_remember', { text: '海马体负责写情景记忆，皮层负责巩固常识，前额叶放当前任务', kind: 'semantic', importance: 0.7 })
const dup = await call('brain_remember', { text: '海马体负责写情景记忆，皮层负责巩固常识，前额叶放当前任务', kind: 'semantic', importance: 0.7 })
console.log('dedupe reinforced =', dup.reinforced)
await call('brain_recall', { query: '记忆用什么数据库存的' })
await call('brain_recall', { query: '产物放哪个盘' })
await call('brain_stats', {})
await call('brain_sleep', {})
await call('brain_recall', { query: '海马体' })
