import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, Config } from '../index.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

let now = 1_000_000
Date.now = () => now

function setup(cfg = {}) {
  const handlers = {}
  const logs = []
  const roots = []
  const all = new Map()
  const ctx = {
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn) },
    logger: () => ({ info: m => logs.push(m), warn: m => logs.push(m) }),
    agents: { roots: () => roots, get: id => all.get(id) },
  }
  apply(ctx, Config(cfg))
  const emit = (ev, p) => (handlers[ev] ?? []).forEach(h => h(p))
  const preStep = (p) => handlers['agent/pre-step'][0](p, async () => ({ kind: 'enter', messages: p.messages }))
  function agent(id, root = true) {
    const a = { id, inbox: { nextTurn: [] }, followed: [] }
    a.followup = m => { a.followed.push(m); a.inbox.nextTurn.push(m); emit('agent/inbox/inserted', { agent: a, message: m }) }
    all.set(id, a); if (root) roots.push(a)
    return a
  }
  return { emit, preStep, agent, logs }
}
const msg = (kind, extra = {}) => createUserMessage({ content: [{ type: 'text', text: kind }], source: { kind, ...extra } })

test('turno umano passa anche dopo lunga inattività', async () => {
  const s = setup(); const a = s.agent('a')
  now += 3_600_000
  const m = msg('user', { rpcId: 'r1' }); a.followup(m)
  assert.equal((await s.preStep({ agent: a, messages: [m], turn: 1, step: 1 })).kind, 'enter')
})

test('schedule bloccato in idle, ammesso se recente', async () => {
  const s = setup({ idleSeconds: 60 }); const a = s.agent('a')
  const m1 = msg('schedule'); a.followup(m1)
  assert.equal((await s.preStep({ agent: a, messages: [m1], turn: 1, step: 1 })).kind, 'enter')
  now += 61_000
  const m2 = msg('schedule'); a.followup(m2)
  assert.equal((await s.preStep({ agent: a, messages: [m2], turn: 2, step: 2 })).kind, 'reject')
  assert.ok(s.logs.some(l => /BLOCCATO/.test(l)))
})

test('step successivi di un turno ammesso non vengono toccati', async () => {
  const s = setup({ idleSeconds: 60 }); const a = s.agent('a')
  const m = msg('user'); a.followup(m)
  await s.preStep({ agent: a, messages: [m], turn: 1, step: 1 })
  now += 600_000 // tool loop lunghissimo
  assert.equal((await s.preStep({ agent: a, messages: [], turn: 1, step: 7 })).kind, 'enter')
})

test('fine turno umano resetta il timer', async () => {
  const s = setup({ idleSeconds: 60 }); const a = s.agent('a')
  const m = msg('user'); a.followup(m)
  await s.preStep({ agent: a, messages: [m], turn: 1, step: 1 })
  now += 1_200_000; s.emit('agent/status', { agent: a, status: 'idle' })
  now += 30_000
  const j = msg('tool-jobs'); a.followup(j)
  assert.equal((await s.preStep({ agent: a, messages: [j], turn: 2, step: 9 })).kind, 'enter')
})

test('allowSources e subagenti', async () => {
  const s = setup({ idleSeconds: 60, allowSources: ['goal'] }); const a = s.agent('a'); const c = s.agent('child', false)
  now += 120_000
  const g = msg('goal'); a.followup(g)
  assert.equal((await s.preStep({ agent: a, messages: [g], turn: 1, step: 1 })).kind, 'enter')
  const cm = msg('agent-message')
  assert.equal((await s.preStep({ agent: c, messages: [cm], turn: 1, step: 1 })).kind, 'enter')
})

test('subagente con source user non resetta il timer', async () => {
  const s = setup({ idleSeconds: 60 }); const a = s.agent('a'); const c = s.agent('child', false)
  now += 120_000
  c.followup(msg('user'))
  const w = msg('webhook'); a.followup(w)
  assert.equal((await s.preStep({ agent: a, messages: [w], turn: 1, step: 1 })).kind, 'reject')
})

test('humanRequiresRpc', async () => {
  const s = setup({ idleSeconds: 60, humanRequiresRpc: true }); const a = s.agent('a')
  now += 120_000
  const m = msg('user'); a.followup(m) // es. subagent driver o headless, senza rpcId
  assert.equal((await s.preStep({ agent: a, messages: [m], turn: 1, step: 1 })).kind, 'reject')
})

test('defer: riconsegna al ritorno, solo i prompt di turno, con limite', async () => {
  const s = setup({ idleSeconds: 60, mode: 'defer', deferLimit: 2 }); const a = s.agent('a')
  now += 120_000
  for (let t = 1; t <= 3; t++) {
    const m = msg('schedule'); a.followup(m)
    const ctxMsg = msg('time-context') // iniettato: non in nextTurn
    assert.equal((await s.preStep({ agent: a, messages: [m, ctxMsg], turn: t, step: t })).kind, 'reject')
  }
  a.followed.length = 0
  a.followup(msg('user', { rpcId: 'x' }))
  await new Promise(r => queueMicrotask(r)); await Promise.resolve()
  const kinds = a.followed.map(m => m.source.kind)
  assert.deepEqual(kinds, ['user', 'schedule', 'schedule'])
})

test('config non valida fallisce al load', () => {
  assert.throws(() => setup({ idleSeconds: 0 }), /idleSeconds/)
})
