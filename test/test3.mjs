import { apply } from '../index.js'

const DB = 'D:\\dsh-output\\tools\\dsh-brain\\test3.db'
const tools = new Map()
const handlers = new Map()
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
  effect: (fn) => fn(),
  on: (name, fn) => { handlers.set(name, fn); return () => {} },
  logger: { info: () => {}, warn: console.warn, debug: () => {} },
}
apply(ctx, { dbPath: DB, capture: true, prime: true })
console.log('listeners:', [...handlers.keys()].join(', '))

const session = {
  id: 'sess-test-1',
  header: { cwd: 'C:\\Users\\23399\\Documents\\deepseek-harness\\default-workspace' },
  snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 7 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后所有导出文件都放 D 盘，别再堆 C 盘了，另外记忆衰减用 FadeMem 的指数公式' }] } },
    { type: 'tool/call', data: { name: 'cad_view' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到，输出统一到 D:\\dsh-output，衰减用 v(t)=v0·exp(-λt^β)，λ 随重要性衰减。' }] } } },
    { type: 'turn/end', data: { turn: 7 } },
  ],
}
handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 7 } })

const call = async (n, a) => {
  const t = tools.get(n)
  const v = await t.execute(a ?? {}, {})
  console.log(`\n== ${n} ==\n` + t.output.render(a ?? {}, v).map((b) => b.text).join('\n'))
  return v
}

await call('brain_stats', {})
await call('brain_recall', { query: '衰减公式怎么写的' })

const decision = await handlers.get('agent/pre-step')(
  { agent: { id: 'a1', session }, step: 1, signal: { aborted: false } },
  async () => ({ kind: 'allow', messages: [] }),
)
console.log('\n== priming injected ==')
for (const m of decision.messages) console.log(m.content.map((c) => c.text).join('\n'))
console.log('\nsource =', JSON.stringify(decision.messages[0].source))
