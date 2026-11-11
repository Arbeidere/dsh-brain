import { DatabaseSync } from 'node:sqlite'
const d = new DatabaseSync('D:\\dsh-output\\tools\\dsh-brain\\brain.db')
const rows = d.prepare(
  "SELECT id, region, kind, state, importance, v0, access_count, source, substr(text,1,60) AS head FROM engrams ORDER BY created_at DESC"
).all()
console.log('meta:', d.prepare('SELECT k, v FROM meta').all())
console.log('count:', rows.length)
for (const r of rows) {
  console.log(`${r.region}/${r.kind} ${r.state} imp=${r.importance} acc=${r.access_count} src=${r.source} :: ${r.head}`)
}
