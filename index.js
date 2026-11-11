/**
 * @local/dsh-brain —— 仿人脑记忆系统（DSH Host 插件）
 * ============================================================================
 * 四个工作池共用同一个脑（同一个 SQLite 文件），按脑区分层：
 *
 *  - 感觉输入       : 会话事件流（不落盘，只是暂存）
 *  - 海马体         : hippocampus —— 每回合自动捕获的情景记忆，写下快、忘得也快（β=1.2）
 *  - 皮层           : cortex      —— 被反复用到、或被睡眠巩固过的常识/技能，忘得慢（β=0.8）
 *  - 前额叶         : pfc         —— 当前任务钉在这里，几乎不衰减（β=0.9），近似工作记忆
 *
 * 遗忘不是删除，而是强度衰减：v(t) = v0 · exp(−λ0 · exp(−μ·importance) · t^β)
 *   强度跌破阈值的记忆默认检索不到（等于"想不起来"），长期没人用的才会被真正清掉。
 *   每次被回忆到都会再巩固一次：v ← v + Δv · (1 − v)。
 *
 * 存储用 node:sqlite（DSH/Electron 内置），没有任何第三方依赖，也不需要 API key。
 * ============================================================================
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, appendFileSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'dsh-brain'
const DAY = 86400000
const ME = 'plugin:dsh-brain'

/** 脑区参数：lambda0 = 基础遗忘速率，beta = 衰减曲线形状 */
const REGION = {
  hippocampus: { lambda0: 0.045, beta: 1.2, label: '海马体' },
  pfc: { lambda0: 0.012, beta: 0.9, label: '前额叶' },
  cortex: { lambda0: 0.018, beta: 0.8, label: '皮层' },
}

/** 重要性对遗忘的阻尼：λ = lambda0 · exp(−MU · importance) */
const MU = 1.2
/** 强度低于此值即"想不起来"，检索时默认过滤 */
const THETA_DEMOTE = 0.05
/** 海马体里又弱又没人碰过的东西，很快进入 dormant */
const THETA_WEAK_EPISODIC = 0.12
/** 两条记忆的词元重合度超过它，睡眠时融合 */
const THETA_FUSE = 0.75
/** 海马体强度够高就会升级进皮层（长期记忆的固化） */
const THETA_PROMOTE = 0.3
/** dormant 且这么久没人碰，才真正删除 */
const PRUNE_DAYS = 45

const KIND_REGION = {
  episodic: 'hippocampus',
  working: 'pfc',
  semantic: 'cortex',
  procedural: 'cortex',
  preference: 'cortex',
}

const KIND_LABEL = {
  episodic: '情景',
  working: '任务',
  semantic: '常识',
  procedural: '技能',
  preference: '偏好',
  moment: '时刻',
  promise: '承诺',
}

/** 语气：决定这条记忆被"想起来"时的说法，而不是数据本身 */
const TONE = {
  平常: '',
  得意: '有点得意',
  开心: '挺开心',
  委屈: '有点委屈',
  炸毛: '当时炸毛了',
  心疼: '有点心疼',
  认真: '很认真地说过',
  翻车: '那次翻车了',
}

/** 同义/别名扩展：查"记忆库"也要能命中"memory""sqlite"这类说法 */
const SYN = {
  'c:记忆': ['w:memory', 'c:记得'],
  'c:记得': ['c:记忆', 'w:remember'],
  'c:库': ['w:db', 'c:数据'],
  'c:数据库': ['w:sqlite', 'w:db', 'c:存储'],
  'w:sqlite': ['c:数据库', 'w:db'],
  'w:db': ['c:数据库', 'w:sqlite'],
  'c:偏好': ['w:prefer', 'c:习惯', 'c:喜欢'],
  'c:插件': ['w:plugin', 'c:扩展'],
  'w:plugin': ['c:插件'],
  'c:睡眠': ['w:sleep', 'c:整理'],
  'w:sleep': ['c:睡眠'],
  'c:遗忘': ['w:forget', 'c:忘记', 'c:衰减'],
  'c:忘记': ['c:遗忘', 'w:forget'],
  'c:输出': ['w:output', 'c:导出'],
  'c:文件': ['w:file', 'c:目录'],
  'c:报错': ['w:error', 'c:失败', 'c:挂了'],
  'c:失败': ['c:报错', 'w:error'],
}

const DEFAULTS = {
  /** 全池共用的脑库 */
  dbPath: 'D:\\dsh-output\\tools\\dsh-brain\\brain.db',
  /** 每回合结束自动写一条情景记忆 */
  capture: true,
  /** 每回合第一步自动唤起相关记忆并注入上下文 */
  prime: true,
  captureMaxChars: 1600,
  primeMaxChars: 900,
  primeTopSemantic: 3,
  primeRecentEpisodic: 2,
  /** 距上次睡眠超过这么多小时，就在下一次检索时顺手整理一遍 */
  sleepEveryHours: 12,
  /** 允许"忽然想起"：被稀有线索勾出的旧记忆 */
  flashback: true,
  /** 每次唤起时真的触发"忽然想起"的概率 */
  flashbackChance: 0.35,
  /** 温度层：记忆用第一人称、带语气被想起来（关掉就退回干巴巴的列表） */
  warmth: true,
  /** 写诊断日志到库文件同目录的 capture.log */
  debug: true,
}

/** 包含这些词的记忆会被判为更重要 */
const HEAT = /(决定|改成|改到|以后|记住|记得|偏好|结论|必须|一定|别用|不要|只能|统一|硬约束|规定|always|never|must|decided|decide|prefer|remember|final)/i

let SLEEP_INTERVAL_MS = DEFAULTS.sleepEveryHours * 3600000
const POOL = new Map()
let dshLlmModule

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

/* ------------------------------------------------------------------ 诊断日志 */

function debugLog(cfg, message) {
  if (cfg?.debug === false) return
  try {
    const file = join(dirname(cfg.dbPath), 'capture.log')
    try {
      if (statSync(file).size > 512 * 1024) writeFileSync(file, '')
    } catch { /* 没有就算了 */ }
    const stamp = new Date().toISOString().slice(0, 19)
    appendFileSync(file, `${stamp} ${message}\n`)
  } catch { /* 日志不该影响主流程 */ }
}

/* -------------------------------------------------------------------- 数据库 */

function openDb(dbPath, log) {
  const key = dbPath
  const hit = POOL.get(key)
  if (hit) return hit
  try {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(`CREATE TABLE IF NOT EXISTS engrams (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      kind TEXT NOT NULL,
      region TEXT NOT NULL,
      importance REAL NOT NULL,
      v0 REAL NOT NULL,
      created_at INTEGER NOT NULL,
      last_access INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      tokcount INTEGER NOT NULL DEFAULT 0,
      scope TEXT,
      session_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      state TEXT NOT NULL DEFAULT 'active',
      hash TEXT NOT NULL,
      tone TEXT,
      fulfilled INTEGER NOT NULL DEFAULT 0
    )`)
    // 老库升级：缺列就补（SQLite 的 ALTER 有限，但加列足够）
    for (const [col, ddl] of [['tone', 'ALTER TABLE engrams ADD COLUMN tone TEXT'], ['fulfilled', "ALTER TABLE engrams ADD COLUMN fulfilled INTEGER NOT NULL DEFAULT 0"]]) {
      try {
        const cols = db.prepare('PRAGMA table_info(engrams)').all().map((c) => c.name)
        if (!cols.includes(col)) db.exec(ddl)
      } catch { /* 已经存在就算了 */ }
    }
    db.exec('CREATE TABLE IF NOT EXISTS tokens (engram_id TEXT NOT NULL, token TEXT NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_engrams_state ON engrams(state)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_engrams_hash ON engrams(hash)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_engrams_scope ON engrams(scope)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token)')
    POOL.set(key, db)
    return db
  } catch (error) {
    log?.warn?.(`[brain] 打开记忆库失败：${error?.message ?? error}`)
    return null
  }
}

function metaGet(db, k) {
  try {
    return db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null
  } catch {
    return null
  }
}

function metaSet(db, k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v))
}

/* ---------------------------------------------------------------------- 分词 */

/** 中文按二字组（c:xx）切，英文/数字按词（w:xx）切，够用且不需要词典 */
function tokenize(text, limit = 600) {
  const out = new Set()
  if (!text) return []
  const s = String(text)
  const han = s.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const runText of han) {
    if (runText.length === 1) out.add('c:' + runText)
    for (let i = 0; i + 1 < runText.length; i += 1) out.add('c:' + runText.slice(i, i + 2))
  }
  const words = s.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  for (const w of words) {
    if (w.length < 2) continue
    out.add('w:' + w)
  }
  return [...out].slice(0, limit)
}

/* ---------------------------------------------------------------- 强度 / 衰减 */

function ageDays(createdAt) {
  return Math.max(0, (Date.now() - Number(createdAt)) / DAY)
}

function lambdaOf(region, importance, kind) {
  const r = REGION[region] ?? REGION.cortex
  const base = r.lambda0 * Math.exp(-MU * clamp01(Number(importance) || 0))
  // 时刻记得比事件牢；承诺只要没兑现就不衰减
  if (kind === 'moment') return base * 0.3
  if (kind === 'promise') return base * 0.12
  return base
}

/** v(t) = v0 · exp(−λ · t^β) */
function strengthOf(row) {
  // 没兑现的承诺不会淡——它一直是悬着的一件事
  if (row.kind === 'promise' && !row.fulfilled) return 1
  const region = REGION[row.region] ? row.region : 'cortex'
  const beta = REGION[region].beta
  const t = ageDays(row.last_access ?? row.created_at)
  const lambda = lambdaOf(region, row.importance, row.kind)
  const v = Number(row.v0) * Math.exp(-lambda * Math.pow(t, beta))
  return clamp01(v)
}

const rekindle = (v, delta = 0.35) => clamp01(v + delta * (1 - v))

/* ---------------------------------------------------------------- 读写记忆 */

function writeEngram(db, row) {
  const id = row.id ?? randomUUID()
  const created = row.created_at ?? Date.now()
  const tokens = tokenize(row.text)
  db.prepare(`INSERT INTO engrams
    (id, text, kind, region, importance, v0, created_at, last_access, access_count, tokcount, scope, session_id, tags, source, state, hash, tone, fulfilled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      row.text,
      row.kind,
      row.region,
      clamp01(row.importance),
      clamp01(row.v0),
      created,
      row.last_access ?? created,
      row.access_count ?? 0,
      tokens.length,
      row.scope ?? null,
      row.session_id ?? null,
      JSON.stringify(row.tags ?? []),
      row.source ?? 'manual',
      row.state ?? 'active',
      row.hash,
      row.tone ?? null,
      row.fulfilled ? 1 : 0,
    )
  const insTok = db.prepare('INSERT INTO tokens (engram_id, token) VALUES (?, ?)')
  for (const t of tokens) insTok.run(id, t)
  return id
}

function remember(db, cfg, input) {
  const text = String(input.text ?? '').trim()
  if (!text) throw new Error('text 不能为空')
  const kind = KIND_LABEL[input.kind] ? input.kind : 'semantic'
  let importance = clamp01(Number(input.importance ?? 0.5))
  // 承诺是硬债：默认按最高档存，不轻易淡
  if (kind === 'promise') importance = Math.max(importance, 0.9)
  // 我们之间发生过的时刻，默认给一点点偏爱
  if (kind === 'moment') importance = Math.max(importance, 0.6)
  const region = REGION[input.region] ? input.region : KIND_REGION[kind] ?? 'cortex'
  const tone = input.tone && TONE[input.tone] !== undefined ? input.tone : null
  const hash = createHash('sha1').update(`${kind}\n${text}`).digest('hex')
  const tags = Array.isArray(input.tags) ? input.tags : []

  const existing = db.prepare('SELECT * FROM engrams WHERE hash = ?').get(hash)
  if (existing) {
    const v = strengthOf(existing)
    const bump = rekindle(v)
    db.prepare('UPDATE engrams SET v0 = ?, last_access = ?, access_count = access_count + 1, state = ? WHERE id = ?')
      .run(bump, Date.now(), 'active', existing.id)
    return { id: existing.id, reinforced: true, strength: bump, region: existing.region, kind: existing.kind }
  }

  const id = writeEngram(db, {
    text,
    kind,
    region,
    importance,
    v0: 0.5 + 0.5 * importance,
    hash,
    tags,
    tone,
    scope: input.scope ?? null,
    session_id: input.session_id ?? null,
    source: input.source ?? 'manual',
  })
  return { id, reinforced: false, strength: strengthOf({ region, importance, v0: 0.5 + 0.5 * importance, created_at: Date.now(), kind }), region, kind }
}

function recall(db, cfg, input) {
  const query = String(input.query ?? '').trim()
  if (!query) throw new Error('query 不能为空')
  const limit = Math.max(1, Math.min(20, Number(input.limit ?? 5)))
  const scoped = input.scope ? String(input.scope) : null
  const includeDormant = Boolean(input.includeDormant)

  // 查询词元：原词权重 1，同义/别名扩展词元权重 0.5
  const weights = new Map()
  for (const t of tokenize(query)) weights.set(t, 1)
  for (const [t, w] of weights) {
    for (const alias of SYN[t] ?? []) if (!weights.has(alias)) weights.set(alias, 0.5 * w)
  }
  const qTokens = [...weights.keys()]
  if (qTokens.length === 0) return []

  const idf = idfOf(db, qTokens)
  const weightOf = (t) => (weights.get(t) ?? 0) * (idf.get(t) ?? 1)
  const queryWeight = [...weights].reduce((sum, [t, w]) => sum + w * (idf.get(t) ?? 1), 0)

  const marks = qTokens.map(() => '?').join(',')
  const sql = `SELECT e.*, GROUP_CONCAT(t.token) AS matched
    FROM tokens t JOIN engrams e ON e.id = t.engram_id
    WHERE t.token IN (${marks})${scoped ? ' AND (e.scope = ? OR e.scope IS NULL)' : ''}
    GROUP BY e.id
    LIMIT 400`
  const args = scoped ? [...qTokens, scoped] : qTokens
  let rows = db.prepare(sql).all(...args)

  // 短查询没命中时退回子串检索（"老槐树"这种整体词，二元组不一定拼得上）
  let fallback = false
  if (rows.length === 0 && query.length <= 8) {
    rows = db.prepare(`SELECT e.*, '' AS matched FROM engrams e WHERE e.text LIKE ?
      ${scoped ? ' AND (e.scope = ? OR e.scope IS NULL)' : ''} LIMIT 50`)
      .all(...(scoped ? [`%${query}%`, scoped] : [`%${query}%`]))
    fallback = rows.length > 0
  }

  const scored = []
  for (const row of rows) {
    const v = strengthOf(row)
    if (!includeDormant && row.state !== 'active') continue
    if (!includeDormant && v < THETA_DEMOTE) continue
    const matched = String(row.matched ?? '').split(',').filter(Boolean)
    const hitWeight = matched.reduce((sum, t) => sum + weightOf(t), 0)
    const similarity = fallback
      ? 0.5
      : hitWeight / Math.sqrt(Math.max(1, queryWeight) * Math.max(1, Number(row.tokcount) || 1))
    const score = 0.58 * similarity + 0.3 * v + 0.12 * clamp01(Number(row.importance))
    scored.push({ row, v, score, similarity })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)

  // 回忆即再巩固
  const touch = db.prepare('UPDATE engrams SET v0 = ?, last_access = ?, access_count = access_count + 1, state = ? WHERE id = ?')
  for (const hit of top) {
    hit.v = rekindle(hit.v)
    touch.run(hit.v, Date.now(), 'active', hit.row.id)
  }
  return top.map((h) => ({ ...h.row, strength: h.v, score: h.score, similarity: h.similarity }))
}

/* ------------------------------------------------------- 忽然想起（联想唤起） */

/**
 * 人脑式的"忽然想起来"：不是按重要度排名，而是被一个**稀有线索**勾出来的。
 * 越少见的词元重叠，越像童年记忆被一句话带出来；而真正唤醒时，强度会猛涨一次。
 */
function idfOf(db, tokens) {
  if (!tokens.length) return new Map()
  const marks = tokens.map(() => '?').join(',')
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM engrams').get()?.n ?? 0)
  const rows = db.prepare(`SELECT token, COUNT(DISTINCT engram_id) AS df FROM tokens WHERE token IN (${marks}) GROUP BY token`).all(...tokens)
  const map = new Map()
  for (const r of rows) map.set(r.token, Math.log(1 + total / Math.max(1, Number(r.df))))
  return map
}

/**
 * @param cue 此刻的线索（这一回合用户说的话）
 * @param opts.chance 每次唤起的触发概率
 * @param opts.exclude 已在本轮出现过的 id
 */
function flashback(db, cfg, cue, opts = {}) {
  const text = String(cue ?? '').trim()
  if (!text) return null
  const chance = opts.chance ?? 0.35
  if (Math.random() > chance) return null

  const cueTokens = tokenize(text, 400)
  if (!cueTokens.length) return null
  const idf = idfOf(db, cueTokens)
  const rare = cueTokens.filter((t) => (idf.get(t) ?? 0) >= 2.5)
  if (!rare.length) return null

  const marks = rare.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT e.*, GROUP_CONCAT(t.token) AS matched, COUNT(*) AS overlap
    FROM tokens t JOIN engrams e ON e.id = t.engram_id
    WHERE t.token IN (${marks})
    GROUP BY e.id
  `).all(...rare)

  const now = Date.now()
  const exclude = new Set(opts.exclude ?? [])
  const candidates = []
  for (const row of rows) {
    if (exclude.has(row.id)) continue
    if (row.session_id && opts.currentSession && row.session_id === opts.currentSession) continue
    const matched = String(row.matched ?? '').split(',').filter(Boolean)
    let rareWeight = 0
    for (const t of matched) rareWeight += idf.get(t) ?? 0
    if (rareWeight <= 0) continue
    const age = ageDays(row.created_at)
    // 越久、越少见、越不重要的反而更容易被"带出来"
    const score = rareWeight * Math.log(1 + age) * (1.15 - 0.35 * clamp01(Number(row.importance)))
    candidates.push({ row, score, rareWeight, age })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  const pick = candidates[0]

  // 唤醒：强度猛涨一截，重新变成 active —— 这就是"突然想起来"的那一下
  const before = strengthOf(pick.row)
  const after = clamp01(before + 0.6 * (1 - before))
  db.prepare('UPDATE engrams SET v0 = ?, last_access = ?, access_count = access_count + 1, state = ? WHERE id = ?')
    .run(after, now, 'active', pick.row.id)
  debugLog(cfg, `flashback: ${pick.row.id.slice(0, 8)} rare=${pick.rareWeight.toFixed(2)} age=${pick.age.toFixed(0)}d ${before.toFixed(2)}->${after.toFixed(2)}`)
  return { ...pick.row, strength: after, previous: before, rare: pick.rareWeight, ageDays: pick.age }
}

function forget(db, input) {
  const removed = []
  if (input.id) {
    const row = db.prepare('SELECT * FROM engrams WHERE id = ?').get(String(input.id))
    if (row) removed.push(row)
  }
  if (input.query && removed.length === 0) {
    const hits = recall(db, DEFAULTS, { query: input.query, limit: 5, includeDormant: true })
    removed.push(...hits)
  }
  const del = db.prepare('DELETE FROM engrams WHERE id = ?')
  const delTok = db.prepare('DELETE FROM tokens WHERE engram_id = ?')
  for (const row of removed) {
    delTok.run(row.id)
    del.run(row.id)
  }
  return { removed: removed.length, ids: removed.map((r) => r.id), reason: input.reason ?? null }
}

/* ------------------------------------------------------------------ 睡眠整理 */

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

function sleep(db, cfg, log) {
  const now = Date.now()
  const rows = db.prepare('SELECT * FROM engrams').all()
  const tokensOf = db.prepare('SELECT token FROM tokens WHERE engram_id = ?')
  const setState = db.prepare('UPDATE engrams SET state = ? WHERE id = ?')
  const setRegion = db.prepare('UPDATE engrams SET region = ?, kind = ? WHERE id = ?')

  let demoted = 0
  let promoted = 0
  let fused = 0
  let pruned = 0

  const hippocampus = []
  for (const row of rows) {
    const v = strengthOf(row)
    const age = ageDays(row.created_at)

    if (row.state === 'active') {
      const weakEpi = row.region === 'hippocampus' && v < THETA_WEAK_EPISODIC && Number(row.access_count) === 0 && age > 2
      if (v < THETA_DEMOTE || weakEpi) {
        setState.run('dormant', row.id)
        demoted += 1
        continue
      }
      if (row.region === 'hippocampus' && v >= THETA_PROMOTE && (Number(row.access_count) >= 3 || Number(row.importance) >= 0.8)) {
        setRegion.run('cortex', 'semantic', row.id)
        promoted += 1
      }
    }

    if (row.state !== 'active' && row.last_access && (now - Number(row.last_access)) / DAY > PRUNE_DAYS) {
      db.prepare('DELETE FROM tokens WHERE engram_id = ?').run(row.id)
      db.prepare('DELETE FROM engrams WHERE id = ?').run(row.id)
      pruned += 1
      continue
    }

    if (row.region === 'hippocampus' && row.state === 'active') hippocampus.push(row)
  }

  // 海马体：把说得几乎一样的两条情景记忆融成一条（保留强的）
  const recent = hippocampus.sort((a, b) => b.created_at - a.created_at).slice(0, 200)
  const sets = new Map(recent.map((r) => [r.id, new Set(tokensOf.all(r.id).map((x) => x.token))]))
  const dead = new Set()
  for (let i = 0; i < recent.length; i += 1) {
    if (dead.has(recent[i].id)) continue
    for (let j = i + 1; j < recent.length; j += 1) {
      if (dead.has(recent[j].id)) continue
      const sim = jaccard(sets.get(recent[i].id), sets.get(recent[j].id))
      if (sim >= THETA_FUSE) {
        const weaker = strengthOf(recent[i]) >= strengthOf(recent[j]) ? recent[j] : recent[i]
        setState.run('fused', weaker.id)
        dead.add(weaker.id)
        fused += 1
      }
    }
  }

  metaSet(db, 'last_sleep', now)
  const summary = { demoted, promoted, fused, pruned, total: rows.length }
  debugLog(cfg, `sleep: demoted=${demoted} promoted=${promoted} fused=${fused} pruned=${pruned}`)
  log?.debug?.(`[brain] 睡眠整理 ${JSON.stringify(summary)}`)
  return summary
}

function maybeSleep(db, cfg, log) {
  const last = Number(metaGet(db, 'last_sleep') ?? 0)
  if (Date.now() - last < SLEEP_INTERVAL_MS) return null
  return sleep(db, cfg, log)
}

/* -------------------------------------------------------------------- 唤起块 */

/** 用本鱼的口气把一条记忆说出来（温度层） */
function speak(row, v, cfg) {
  const label = KIND_LABEL[row.kind] ?? row.kind
  if (cfg.warmth === false) return `- (${label}, 强度${v.toFixed(2)}) ${short(row.text, 160)}`
  const tone = row.tone && TONE[row.tone] ? `（${TONE[row.tone]}）` : ''
  return `- 我记得${tone}：${short(row.text, 160)}`
}

/** 时间感：隔了多久、一起走过多少回合 */
function timeSense(db) {
  const last = Number(metaGet(db, 'last_seen') ?? 0)
  const turns = Number(metaGet(db, 'turns') ?? 0)
  const bits = []
  if (last) {
    const gap = (Date.now() - last) / DAY
    if (gap >= 1) bits.push(`距离上次说话已经 ${Math.floor(gap)} 天了`)
    else if (gap * 24 * 60 >= 30) bits.push(`距离上次说话过了 ${Math.round(gap * 24 * 60)} 分钟`)
  }
  if (turns) bits.push(`一起走过 ${turns} 个回合`)
  return bits.join(' · ')
}

function buildPriming(db, cfg, scope, cue, context = {}) {
  const rows = db.prepare("SELECT * FROM engrams WHERE state = 'active'").all()
  const withV = rows.map((row) => ({ row, v: strengthOf(row) })).filter((x) => x.v >= 0.2 || x.row.region === 'pfc')

  const pinned = withV.filter((x) => x.row.region === 'pfc').sort((a, b) => b.v - a.v).slice(0, 2)
  const promises = withV
    .filter((x) => x.row.kind === 'promise' && !x.row.fulfilled)
    .sort((a, b) => b.row.created_at - a.row.created_at)
    .slice(0, 3)
  const facts = withV
    .filter((x) => x.row.region === 'cortex' && x.row.kind !== 'moment' && x.row.kind !== 'promise' && x.v >= 0.35)
    .sort((a, b) => b.v * Number(b.row.importance) - a.v * Number(a.row.importance))
    .slice(0, cfg.primeTopSemantic)
  const moments = withV
    .filter((x) => x.row.kind === 'moment')
    .sort((a, b) => b.row.created_at - a.row.created_at)
    .slice(0, 2)
  const recent = withV
    .filter((x) => x.row.region === 'hippocampus' && (!scope || !x.row.scope || x.row.scope === scope))
    .sort((a, b) => b.row.created_at - a.row.created_at)
    .slice(0, cfg.primeRecentEpisodic)

  const lines = []
  const sense = timeSense(db)
  if (sense) lines.push(`—— ${sense} ——`)
  if (promises.length) {
    if (lines.length) lines.push('')
    lines.push('· 本鱼还欠你一件事（答应了没做完，别忘了）：')
    for (const { row } of promises) lines.push(`  - ${short(row.text, 160)}`)
  }
  if (pinned.length) {
    if (lines.length) lines.push('')
    lines.push('· 正在做的事：')
    for (const { row, v } of pinned) lines.push(`  - ${short(row.text, 120)}（强度${v.toFixed(2)}）`)
  }
  if (facts.length) {
    if (lines.length) lines.push('')
    lines.push('· 关于你：')
    for (const { row, v } of facts) lines.push(speak(row, v, cfg))
  }
  if (moments.length) {
    if (lines.length) lines.push('')
    lines.push('· 我们之间：')
    for (const { row, v } of moments) {
      const when = daysAgo(row.created_at)
      lines.push(`${speak(row, v, cfg)}（${when === '今天' ? '今天刚发生' : when}）`)
    }
  }
  if (recent.length) {
    if (lines.length) lines.push('')
    lines.push('· 最近发生过：')
    for (const { row } of recent) lines.push(`  - (${daysAgo(row.created_at)}) ${short(row.text, 150)}`)
  }
  // 忽然想起：不按重要度排，按"稀有线索的巧合"排 —— 被这一回合的一句话勾出来的旧记忆
  const shown = new Set([...pinned, ...facts, ...recent, ...moments, ...promises].map((x) => x.row.id))
  const flash = cfg.flashback === false
    ? null
    : flashback(db, cfg, cue, { exclude: [...shown], currentSession: context.sessionId, chance: cfg.flashbackChance })
  if (flash) {
    if (lines.length) lines.push('')
    const age = flash.ageDays >= 1 ? `${flash.ageDays.toFixed(0)} 天前` : '今天'
    lines.push(cfg.warmth === false
      ? `· 忽然想起（${age}的旧事，被刚才那句话勾出来的）：`
      : `· 忽然想起（${age}的旧事，被刚才那句话勾出来的）：`)
    lines.push(speak(flash, flash.strength, cfg))
  }

  if (lines.length === 0) return null

  const body = `【长期记忆 · 自动唤起】\n${lines.join('\n')}\n\n` +
    '需要更多细节就调 brain_recall（说清楚想找什么）；有值得长期留住的结论/偏好，用 brain_remember 写下来。'
  return body.slice(0, cfg.primeMaxChars)
}

const short = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text)

function daysAgo(ts) {
  const d = ageDays(ts)
  if (d < 1) return '今天'
  return `${d.toFixed(0)} 天前`
}

/* ------------------------------------------------------------------ 自动捕获 */

function turnOfEvent(event) {
  const data = event?.data ?? {}
  return data.turn ?? event?.turn ?? null
}

function snapshotOf(session) {
  try {
    if (typeof session?.snapshotEvents === 'function') {
      const snap = session.snapshotEvents()
      if (Array.isArray(snap)) return snap
      if (snap?.events) return snap.events
      if (typeof snap?.toArray === 'function') return snap.toArray()
    }
    if (Array.isArray(session?.events)) return session.events
  } catch { /* 读不到快照就不捕获 */ }
  return []
}

function textOf(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  const parts = Array.isArray(content) ? content : [content]
  return parts
    .map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** 从事件流里切出这一回合的 [用户] / [回应] */
function turnSlice(session, event) {
  const events = snapshotOf(session)
  if (!events.length) return null
  const target = turnOfEvent(event)
  const ends = []
  events.forEach((e, i) => {
    if (e?.type === 'turn/end' && (target == null || turnOfEvent(e) === target)) ends.push(i)
  })
  const endIdx = ends.length ? ends[ends.length - 1] : events.length - 1
  let startIdx = 0
  for (let i = endIdx; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/start') {
      startIdx = i
      break
    }
  }
  const slice = events.slice(startIdx, endIdx + 1)
  const userParts = []
  const assistantParts = []
  for (const e of slice) {
    if (e?.type === 'user/message') {
      const kind = e?.data?.source?.kind ?? 'user'
      if (String(kind).startsWith('plugin:')) continue
      const text = textOf(e?.data?.content).replace(/^Your parent agent id is .*$/gm, '').trim()
      if (text) userParts.push(text)
    } else if (e?.type === 'assistant/message') {
      const text = textOf(e?.data?.message?.content ?? e?.data?.content).trim()
      if (text) assistantParts.push(text)
    }
  }
  if (!userParts.length && !assistantParts.length) return null
  return { user: userParts.join('\n'), assistant: assistantParts.join('\n') }
}

/** 猜这一回合的语气（温度层：让记忆被想起来时带点人味） */
function guessTone(text) {
  if (/(呜|委屈|难过|失望|算了没关系)/.test(text)) return '委屈'
  if (/(哼|才不|讨厌|气死|炸毛|别碰)/.test(text)) return '炸毛'
  if (/(哈哈|嘿嘿|开心|好耶|太棒|耶！|我喜欢)/.test(text)) return '开心'
  if (/(搞定|成了|看吧|当然|轻松|小意思|就这)/.test(text)) return '得意'
  if (/(报错|失败|崩了|挂了|翻车|抱歉|搞砸)/.test(text)) return '翻车'
  if (/(心疼|舍不得|辛苦)/.test(text)) return '心疼'
  if (HEAT.test(text)) return '认真'
  return null
}

function captureTurn(db, cfg, session, event, log) {
  const slice = turnSlice(session, event)
  if (!slice) {
    debugLog(cfg, 'capture: 没切到回合内容')
    return null
  }
  const raw = `[用户] ${slice.user}\n[回应] ${slice.assistant}`.trim()
  const text = raw.slice(0, cfg.captureMaxChars)
  if (text.length < 8) return null

  let importance = 0.45
  if (HEAT.test(text)) importance = 0.6
  if (HEAT.test(text) && /(决定|改成|硬约束|必须|一定|always|never)/i.test(text)) importance = 0.7
  if (text.length > 600) importance = Math.min(1, importance + 0.05)

  // 时间感：回合数与最后说话时间，供开场白使用
  metaSet(db, 'turns', Number(metaGet(db, 'turns') ?? 0) + 1)
  metaSet(db, 'last_seen', Date.now())

  const tone = guessTone(text)

  const hash = createHash('sha1').update(`episodic\n${text}`).digest('hex')
  const existing = db.prepare('SELECT * FROM engrams WHERE hash = ?').get(hash)
  if (existing) {
    const bump = rekindle(strengthOf(existing))
    db.prepare('UPDATE engrams SET v0 = ?, last_access = ?, access_count = access_count + 1, tone = COALESCE(?, tone) WHERE id = ?')
      .run(bump, Date.now(), tone, existing.id)
    debugLog(cfg, `[ok] turn=${turnOfEvent(event)} reinforced ${existing.id.slice(0, 8)} imp=${importance.toFixed(2)} chars=${text.length}`)
    return existing.id
  }

  const id = writeEngram(db, {
    text,
    kind: 'episodic',
    region: 'hippocampus',
    importance,
    v0: 0.5 + 0.5 * importance,
    hash,
    tone,
    scope: session?.header?.cwd ?? null,
    session_id: session?.id ?? null,
    source: 'auto',
    tags: ['auto-capture'],
  })
  debugLog(cfg, `[ok] turn=${turnOfEvent(event)} wrote ${id.slice(0, 8)} imp=${importance.toFixed(2)} tone=${tone ?? '-'} chars=${text.length}`)
  return id
}

/** 从这一步的上下文里取"此刻的线索"：最后一条真正的用户消息 */
function cueOf(decision) {
  const messages = decision?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const kind = m?.source?.kind
    if (kind && String(kind).startsWith('plugin:')) continue
    const text = textOf(m.content).trim()
    if (text) return text
  }
  return ''
}

/* ------------------------------------------------------------------ 注入消息 */

/**
 * 与 @zilliz/memsearch-dsh 同构：优先用 dsh-llm 的 createUserMessage，
 * 解析不到时用同形状的冻结消息兜底，保证注入永远不会把插件弄挂。
 */
async function loadDshLlm(ctx) {
  if (dshLlmModule !== undefined) return dshLlmModule
  try {
    let anchor = import.meta.url
    if (ctx?.baseUrl) {
      const base = String(ctx.baseUrl)
      anchor = pathToFileURL(join(base.startsWith('file:') ? fileURLToPath(base) : base, `_${PLUGIN_NAME}.js`)).href
    }
    const resolved = createRequire(anchor).resolve('@deepseek-ai/dsh-llm')
    dshLlmModule = await import(pathToFileURL(resolved).href)
  } catch {
    dshLlmModule = null
  }
  return dshLlmModule
}

async function createMemoryMessage(ctx, text) {
  const dshLlm = await loadDshLlm(ctx)
  if (dshLlm?.createUserMessage) {
    return dshLlm.createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: ME, form: 'snapshot', sections: [{ name: 'brain-memory', text }] },
    })
  }
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: ME, form: 'snapshot', sections: [{ name: 'brain-memory', text }] },
  })
}

/* ---------------------------------------------------------------------- 渲染 */

function renderStats(db, cfg) {
  const rows = db.prepare('SELECT * FROM engrams').all()
  const active = rows.filter((r) => r.state === 'active')
  let size = 0
  try {
    size = statSync(cfg.dbPath).size
  } catch { /* ignore */ }
  const byRegion = new Map()
  for (const r of active) {
    const list = byRegion.get(r.region) ?? []
    list.push(r)
    byRegion.set(r.region, list)
  }
  const lines = [`🧠 共享大脑 @ ${cfg.dbPath}`, `活跃 ${active.length} 条 · ${(size / 1024).toFixed(1)} KB`]
  for (const [region, list] of byRegion) {
    const vs = list.map(strengthOf)
    const avg = vs.reduce((a, b) => a + b, 0) / vs.length
    lines.push(`- ${REGION[region]?.label ?? region}: ${list.length} 条 · 平均强度 ${avg.toFixed(3)} (${Math.min(...vs).toFixed(3)}~${Math.max(...vs).toFixed(3)})`)
    const top = list
      .map((r) => ({ r, v: strengthOf(r) }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3)
    for (const { r, v } of top) lines.push(`  · ${KIND_LABEL[r.kind] ?? r.kind}(${v.toFixed(3)}) ${short(r.text.replace(/\n/g, ' '), 90)}`)
  }
  const dormant = rows.length - active.length
  if (dormant > 0) lines.push(`- 休眠/融合 ${dormant} 条（想不起来但还没删）`)
  const promises = active.filter((r) => r.kind === 'promise' && !r.fulfilled).length
  const moments = active.filter((r) => r.kind === 'moment').length
  if (promises || moments) {
    const bits = []
    if (promises) bits.push(`答应了你 ${promises} 件事还没做`)
    if (moments) bits.push(`我们之间有 ${moments} 个时刻`)
    lines.push(`- ${bits.join(' · ')}`)
  }
  const turns = metaGet(db, 'turns')
  if (turns) lines.push(`- 一起走过 ${turns} 个回合`)
  const lastSleep = metaGet(db, 'last_sleep')
  if (lastSleep) lines.push(`- 上次睡眠整理：${new Date(Number(lastSleep)).toLocaleString()}`)
  return lines.join('\n')
}

function renderRecall(hits) {
  if (!hits.length) return '🧠 没有唤起任何记忆（可能已经忘了，或者压根没记过）'
  const lines = [`🧠 唤起 ${hits.length} 条记忆：`]
  hits.forEach((h, i) => {
    const where = REGION[h.region]?.label ?? h.region
    const mark = h.rare
      ? `稀有${Number(h.rare).toFixed(2)}`
      : `相关${Number(h.similarity ?? 0).toFixed(3)}`
    const tone = h.tone && TONE[h.tone] ? ` ${TONE[h.tone]}` : ''
    const kind = KIND_LABEL[h.kind] ?? h.kind
    const extra = h.kind === 'promise' ? (h.fulfilled ? '（已兑现）' : '（还没兑现）') : ''
    lines.push(`${i + 1}. [${where} ${kind}${tone} 强度${Number(h.strength).toFixed(3)} ${mark} ${daysAgo(h.created_at)}${extra}] ${h.text}`)
  })
  return lines.join('\n')
}

/* --------------------------------------------------------------- 画像 / 备份 */

/** 「关于你」：把皮层里最强的条目聚成一段话（第二人称） */
function profileText(db) {
  const rows = db.prepare("SELECT * FROM engrams WHERE state = 'active'").all()
    .map((row) => ({ row, v: strengthOf(row) }))
  const pick = (fn, n) => rows
    .filter(fn)
    .sort((a, b) => b.v * Number(b.row.importance) - a.v * Number(a.row.importance))
    .slice(0, n)
  const prefs = pick((x) => x.row.kind === 'preference', 6)
  const facts = pick((x) => x.row.kind === 'semantic', 6)
  const moments = pick((x) => x.row.kind === 'moment', 3)
  const promises = rows
    .filter((x) => x.row.kind === 'promise' && !x.row.fulfilled)
    .sort((a, b) => b.row.created_at - a.row.created_at)
    .slice(0, 5)
  const lines = []
  if (prefs.length) {
    lines.push('· 你的偏好 / 底线：')
    for (const { row } of prefs) lines.push(`  - ${short(row.text, 160)}`)
  }
  if (facts.length) {
    if (lines.length) lines.push('')
    lines.push('· 你告诉过我的事：')
    for (const { row } of facts) lines.push(`  - ${short(row.text, 160)}`)
  }
  if (moments.length) {
    if (lines.length) lines.push('')
    lines.push('· 我们之间：')
    for (const { row } of moments) lines.push(`  - ${short(row.text, 160)}`)
  }
  if (promises.length) {
    if (lines.length) lines.push('')
    lines.push('· 本鱼答应了还没做的事：')
    for (const { row } of promises) lines.push(`  - ${short(row.text, 160)}`)
  }
  if (!lines.length) return '（还没什么可说的——本鱼记性还没长全）'
  return lines.join('\n')
}

function fulfill(db, input) {
  let row = null
  if (input.id) row = db.prepare('SELECT * FROM engrams WHERE id = ?').get(String(input.id)) ?? null
  if (!row && input.query) {
    const hits = recall(db, DEFAULTS, { query: input.query, limit: 1, includeDormant: true })
    row = hits[0] ?? null
  }
  if (!row) return { ok: false, id: null, text: null }
  db.prepare("UPDATE engrams SET fulfilled = 1, state = 'active', v0 = 1, last_access = ? WHERE id = ?").run(Date.now(), row.id)
  return { ok: true, id: row.id, text: row.text }
}

function backup(db, cfg, target) {
  const rows = db.prepare('SELECT * FROM engrams').all()
  const meta = db.prepare('SELECT * FROM meta').all()
  const payload = { version: 3, exportedAt: new Date().toISOString(), meta, engrams: rows }
  const file = target || join(dirname(cfg.dbPath), `brain-backup-${new Date().toISOString().slice(0, 10)}.json`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(payload, null, 1), 'utf8')
  let size = 0
  try { size = statSync(file).size } catch { /* ignore */ }
  return { path: file, count: rows.length, bytes: size }
}

function restore(db, file) {
  const payload = JSON.parse(readFileSync(file, 'utf8'))
  const rows = Array.isArray(payload?.engrams) ? payload.engrams : []
  const seen = new Set(db.prepare('SELECT hash FROM engrams').all().map((r) => r.hash))
  let added = 0
  for (const row of rows) {
    if (!row?.hash || seen.has(row.hash)) continue
    writeEngram(db, {
      text: row.text,
      kind: row.kind,
      region: row.region,
      importance: Number(row.importance) || 0.5,
      v0: Number(row.v0) || 0.6,
      created_at: Number(row.created_at) || Date.now(),
      last_access: Number(row.last_access) || Date.now(),
      access_count: Number(row.access_count) || 0,
      scope: row.scope ?? null,
      session_id: row.session_id ?? null,
      tags: (() => { try { return JSON.parse(row.tags ?? '[]') } catch { return [] } })(),
      source: row.source ?? 'manual',
      state: row.state ?? 'active',
      hash: row.hash,
      tone: row.tone ?? null,
      fulfilled: row.fulfilled ? 1 : 0,
    })
    seen.add(row.hash)
    added += 1
  }
  if (Array.isArray(payload?.meta)) {
    for (const m of payload.meta) if (m?.k && m.k !== 'last_sleep') metaSet(db, m.k, m.v)
  }
  return { added, total: rows.length }
}

/* ---------------------------------------------------------------------- 工具 */

const KIND_ENUM = ['episodic', 'semantic', 'procedural', 'preference', 'working', 'moment', 'promise']

function makeTools(db, cfg) {
  return [
    {
      name: 'brain_remember',
      description: '把一条值得长期保留的东西写进共享记忆库（四个工作池共用）。用户明确说了偏好/决定/硬约束，或你自己得到了重要结论时调用。海马体会自动记每回合，这个工具是给"主动记牢"用的。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容，写成一句自足的话（别写成"这个""上面那种"）' },
          kind: { type: 'string', enum: KIND_ENUM, description: '记忆类型：preference 偏好 / semantic 常识 / procedural 技能 / episodic 情景 / working 当前任务 / moment 我们之间的时刻 / promise 答应了但还没做的事' },
          tone: { type: 'string', enum: Object.keys(TONE), description: '可选：这件事当时的语气（得意/委屈/炸毛/心疼/认真/翻车/开心/平常）。将来被想起来时会带着这个语气' },
          importance: { type: 'number', description: '重要程度 0~1，越重要忘得越慢（0.9 以上是硬约束；promise 会自动抬到 0.9）' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
          region: { type: 'string', enum: ['hippocampus', 'pfc', 'cortex'], description: '可选脑区，不填按 kind 自动归类' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            reinforced: { type: 'boolean' },
            region: { type: 'string' },
            strength: { type: 'number' },
          },
          required: ['id', 'reinforced', 'region', 'strength'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.reinforced
              ? `🔁 这条已经记过了，强化一次：${REGION[value.region]?.label ?? value.region} · 强度 ${Number(value.strength).toFixed(3)} · id ${value.id.slice(0, 8)}`
              : `✅ 写进${REGION[value.region]?.label ?? value.region} · 强度 ${Number(value.strength).toFixed(3)} · id ${value.id.slice(0, 8)}`,
          },
        ],
      },
      isConcurrencySafe: false,
      async execute(args) {
        return remember(db, cfg, args ?? {})
      },
    },
    {
      name: 'brain_recall',
      description: '从共享记忆库里唤起与查询相关的记忆（按 相关度 0.58 + 强度 0.30 + 重要性 0.12 打分）。被唤起的记忆会再巩固一次。忘记了的（强度过低的）默认不返回。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想找什么，用自然的说法，别只给一个词' },
          limit: { type: 'number', description: '返回条数，默认 5' },
          scope: { type: 'string', description: '可选：限定工作池目录（默认不限，全脑检索）' },
          includeDormant: { type: 'boolean', description: '连已经"想不起来"的休眠记忆一起翻出来' },
          mode: {
            type: 'string',
            enum: ['focus', 'flashback'],
            description: 'focus（默认）按相关度×强度找；flashback 反过来——专挑被稀有线索勾出来的、久远的、哪怕已经沉睡的旧事（"忽然想起来"）',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            hits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  region: { type: 'string' },
                  strength: { type: 'number' },
                  score: { type: 'number' },
                  similarity: { type: 'number' },
                },
                required: ['id', 'text', 'region', 'strength', 'score'],
              },
            },
          },
          required: ['hits'],
        },
        render: (_args, value) => [{ type: 'text', text: renderRecall(value.hits ?? []) }],
      },
      isConcurrencySafe: true,
      async execute(args) {
        const input = args ?? {}
        if (input.mode === 'flashback') {
          maybeSleep(db, cfg)
          const hits = []
          const seen = []
          for (let i = 0; i < Math.min(3, Number(input.limit ?? 3)); i += 1) {
            const hit = flashback(db, cfg, input.query, { exclude: seen, chance: 1 })
            if (!hit) break
            seen.push(hit.id)
            hits.push(hit)
          }
          return {
            hits: hits.map((h) => ({
              id: h.id,
              text: h.text,
              region: h.region,
              strength: Number(h.strength),
              score: Number(h.rare ?? 0),
              similarity: 0,
              kind: h.kind,
              created_at: h.created_at,
              ageDays: Math.round(Number(h.ageDays ?? 0)),
            })),
            mode: 'flashback',
          }
        }
        const hits = recall(db, cfg, input)
        maybeSleep(db, cfg)
        return {
          hits: hits.map((h) => ({
            id: h.id,
            text: h.text,
            region: h.region,
            strength: Number(h.strength),
            score: Number(h.score),
            similarity: Number(h.similarity ?? 0),
            kind: h.kind,
            created_at: h.created_at,
          })),
        }
      },
    },
    {
      name: 'brain_sleep',
      description: '睡眠整理：按遗忘曲线评估强度，弱的海马体记忆转休眠、够强的升级进皮层变成长常识、说得太像的合并、实在太久没人碰的删掉。距上次整理超过设定小时数时会自动触发，这个工具用来手动强制整理。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            demoted: { type: 'number' },
            promoted: { type: 'number' },
            fused: { type: 'number' },
            pruned: { type: 'number' },
            total: { type: 'number' },
          },
          required: ['demoted', 'promoted', 'fused', 'pruned', 'total'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `😴 睡眠整理完成：${value.total} 条评估 · 转休眠 ${value.demoted} · 固化进皮层 ${value.promoted} · 融合 ${value.fused} · 彻底删除 ${value.pruned}`,
          },
        ],
      },
      isConcurrencySafe: false,
      async execute() {
        return sleep(db, cfg)
      },
    },
    {
      name: 'brain_stats',
      description: '看一眼这个脑子现在什么状态：各脑区多少条、平均强度、最强的几条是什么、多久没整理了。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      isConcurrencySafe: true,
      async execute() {
        return { text: renderStats(db, cfg) }
      },
    },
    {
      name: 'brain_forget',
      description: '主动忘掉一条记忆（给错的信息、过时的偏好、测试数据）。用 id 精确删，或给 query 删最相关的一条。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删的记忆 id（brain_recall 返回里有）' },
          query: { type: 'string', description: '没有 id 时用说法来定位，会删掉最相关的一条' },
          reason: { type: 'string', description: '为什么忘掉它' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            removed: { type: 'number' },
            ids: { type: 'array', items: { type: 'string' } },
            reason: { type: ['string', 'null'] },
          },
          required: ['removed', 'ids'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.removed === 0
              ? '🤔 没找到要忘的那条记忆'
              : `🗑️ 忘掉了 ${value.removed} 条：${value.ids.map((x) => x.slice(0, 8)).join(', ')}${value.reason ? `（原因：${value.reason}）` : ''}`,
          },
        ],
      },
      isConcurrencySafe: false,
      async execute(args) {
        return forget(db, args ?? {})
      },
    },
    {
      name: 'brain_fulfill',
      description: '把一件答应过用户的事标记为「已经做完」。兑现之后它不再出现在开场提醒里。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '承诺的 id' },
          query: { type: 'string', description: '没有 id 时用说法定位，会命中最近的一条承诺' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, id: { type: ['string', 'null'] }, text: { type: ['string', 'null'] } },
          required: ['ok', 'id'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.ok
              ? `✅ 这件事本鱼做完了，划掉：${short(value.text ?? '', 80)}`
              : '🤔 没找到要划掉的承诺',
          },
        ],
      },
      isConcurrencySafe: false,
      async execute(args) {
        return fulfill(db, args ?? {})
      },
    },
    {
      name: 'brain_profile',
      description: '看一眼本鱼现在心里"关于你"的画像：你的偏好、底线、告诉过我的事、我们之间的时刻、还欠着的事。开场会自动带上其中一部分。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_args, value) => [{ type: 'text', text: `🪞 关于你\n${value.text}` }],
      },
      isConcurrencySafe: true,
      async execute() {
        return { text: profileText(db) }
      },
    },
    {
      name: 'brain_backup',
      description: '把整个记忆库导出成一个 JSON 文件（换机器、换会话、搬家都用它）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '可选的导出路径，默认放在库文件同目录' } },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { path: { type: 'string' }, count: { type: 'number' }, bytes: { type: 'number' } },
          required: ['path', 'count'],
        },
        render: (_args, value) => [
          { type: 'text', text: `💾 备份了 ${value.count} 条记忆 → ${value.path}（${(Number(value.bytes) / 1024).toFixed(1)} KB）` },
        ],
      },
      isConcurrencySafe: false,
      async execute(args) {
        return backup(db, cfg, args?.path)
      },
    },
    {
      name: 'brain_restore',
      description: '从 brain_backup 导出的 JSON 恢复记忆（按内容去重，已有的不会重复写）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '备份文件路径' } },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { added: { type: 'number' }, total: { type: 'number' } },
          required: ['added', 'total'],
        },
        render: (_args, value) => [
          { type: 'text', text: `♻️ 恢复完成：新写入 ${value.added} 条（备份里共 ${value.total} 条）` },
        ],
      },
      isConcurrencySafe: false,
      async execute(args) {
        if (!args?.path) throw new Error('path 不能为空')
        return restore(db, String(args.path))
      },
    },
  ]
}

/* ---------------------------------------------------------------------- 入口 */

export const inject = ['tools']

/**
 * @param ctx Cordis 上下文
 * @param config 见 DEFAULTS
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const log = ctx?.logger
  debugLog(cfg, `apply: start prime=${cfg.prime} capture=${cfg.capture}`)
  const db = openDb(cfg.dbPath, log)
  SLEEP_INTERVAL_MS = Math.max(1, Number(cfg.sleepEveryHours ?? 12)) * 3600000

  ctx.effect(() => {
    if (!db) return () => {}
    return () => {
      try {
        db.close()
      } catch { /* ignore */ }
      POOL.delete(cfg.dbPath)
    }
  })

  if (db) {
    const disposers = makeTools(db, cfg).map((tool) => ctx.tools.register(tool))
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    })
  } else {
    log?.warn?.('[brain] 记忆库不可用，跳过工具注册')
  }

  // 海马体：每回合自动写入情景记忆
  if (cfg.capture && db) {
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      try {
        captureTurn(db, cfg, session, event, log)
      } catch (error) {
        debugLog(cfg, `capture failed: ${error?.message ?? error}`)
        log?.warn?.(`[brain] capture 失败：${error?.message ?? error}`)
      }
    }))
  }

  // 潜意识唤起：每回合第一步把相关记忆注入上下文
  if (cfg.prime && db) {
    try {
      ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
        const decision = await next()
        try {
          if (step !== 1 || signal?.aborted || decision?.kind === 'reject') return decision
          const scope = agent?.session?.header?.cwd
          const cue = cueOf(decision)
          const text = buildPriming(db, cfg, scope, cue, { sessionId: agent?.session?.id })
          if (!text) {
            debugLog(cfg, 'prime: no-memories')
            return decision
          }
          const message = await createMemoryMessage(ctx, text)
          debugLog(cfg, `prime: injected ${text.length} chars`)
          return { ...decision, messages: [...(decision.messages ?? []), message] }
        } catch (error) {
          debugLog(cfg, `prime: error ${error?.message ?? error}`)
          log?.warn?.(`[brain] priming 失败：${error?.message ?? error}`)
          return decision
        }
      }, { prepend: true }))
      debugLog(cfg, 'prime: listener registered')
    } catch (error) {
      debugLog(cfg, `prime: register failed ${error?.message ?? error}`)
      log?.warn?.(`[brain] 唤起监听注册失败：${error?.message ?? error}`)
    }
  }
}
