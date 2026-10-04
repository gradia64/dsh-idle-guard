/**
 * Idle Guard per DeepSeek Harness (scritto e verificato contro dsh 0.2.0-rc.2).
 *
 * Criterio: un turno è "umano" se il primo step reclama un messaggio con
 * `source.kind === 'user'` destinato a un agente root (stesso criterio che dsh
 * usa in `goal/tool-goal/src/authority.ts` → hasDirectHumanInput). I turni
 * umani passano sempre, con tutti i loro step. Un turno NON umano (schedule,
 * webhook, hook, job, goal, subagent-settled, team…) viene rifiutato in
 * `agent/pre-step` se dall'ultima attività umana sono passati più di
 * `idleSeconds`, a meno che la sua sorgente sia in `allowSources`.
 *
 * Il rifiuto avviene solo al primo step del turno: il loop chiude il turno con
 * reason `blocked`, senza alcuna richiesta al modello e senza lasciare tool
 * call a metà. Gli step successivi di un turno già ammesso non vengono mai
 * toccati.
 *
 * @module dsh-idle-guard
 */

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'idle-guard'
export const inject = ['agents']

/**
 * @typedef {object} Config
 * @property {number} idleSeconds - inattività dopo cui i turni non umani vengono bloccati.
 * @property {'drop' | 'defer'} mode - `drop` scarta i messaggi bloccati; `defer` li riconsegna al ritorno dell'utente.
 * @property {string[]} allowSources - `source.kind` sempre ammessi anche in idle (es. `goal`, `tool-jobs`).
 * @property {boolean} humanRequiresRpc - conta come umano solo l'input dalla Web UI / API (`source.rpcId`).
 * @property {boolean} guardSubagents - applica il blocco anche agli agenti non-root.
 * @property {number} deferLimit - massimo di messaggi rimandati per agente (si tengono i più recenti).
 * @property {boolean} debug - stampa ogni decisione presa al primo step di un turno.
 * @property {boolean} logToConsole - scrive anche su console (serve nel profilo web; su profili con un exporter console mettilo a false).
 */

export const Config = Schema.object({
  idleSeconds: Schema.number().default(600),
  mode: Schema.union(['drop', 'defer']).default('drop'),
  allowSources: Schema.array(Schema.string()).default([]),
  humanRequiresRpc: Schema.boolean().default(false),
  guardSubagents: Schema.boolean().default(false),
  deferLimit: Schema.number().default(10),
  debug: Schema.boolean().default(false),
  logToConsole: Schema.boolean().default(true),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} config
 */
export function apply(ctx, config) {
  if (!Number.isFinite(config.idleSeconds) || config.idleSeconds < 1) {
    throw new Error(`idle-guard: idleSeconds non valido (${config.idleSeconds}), serve un numero >= 1`)
  }
  if (!Number.isInteger(config.deferLimit) || config.deferLimit < 1) {
    throw new Error(`idle-guard: deferLimit non valido (${config.deferLimit}), serve un intero >= 1`)
  }

  // Nel profilo web nessun exporter stampa ctx.logger su terminale dopo il boot:
  // scriviamo anche su console, come fanno gli altri plugin della community.
  const logger = ctx.logger('idle-guard')
  const out = (level, prefix, m) => {
    logger[level]?.(m)
    if (config.logToConsole) console[level === 'warn' ? 'warn' : 'log'](`${prefix} ${m}`)
  }
  const log = {
    info: (m) => out('info', '[idle-guard]', m),
    warn: (m) => out('warn', '[idle-guard]', m),
    debug: (m) => { if (config.debug) out('debug', '[idle-guard:debug]', m) },
  }
  log.info(`attivo: idleSeconds=${config.idleSeconds}, mode=${config.mode}, allowSources=[${config.allowSources.join(', ')}]`)
  ctx.on('dispose', () => { console.log('[idle-guard] scaricato') })
  const idleMs = config.idleSeconds * 1000
  const allow = new Set(config.allowSources)

  /** Avvio di dsh = attività umana: niente blocchi nei primi idleSeconds. */
  let lastActivity = Date.now()
  /** Ultimo turno già valutato per agente: gli step successivi passano. */
  const decidedTurn = new WeakMap()
  /** Agenti il cui turno corrente è stato aperto da un umano. */
  const humanTurn = new WeakSet()
  /** Id dei messaggi accodati come prompt di un nuovo turno (followup), per agente. */
  const turnPrompts = new WeakMap()
  const promptsOf = (agent) => {
    let set = turnPrompts.get(agent)
    if (!set) turnPrompts.set(agent, set = new Set())
    return set
  }
  /** Messaggi rimandati (mode: defer), per agente. */
  const deferred = new Map()

  const isRoot = agent => ctx.agents.roots().includes(agent)

  const isHuman = (agent, message) =>
    message.source.kind === 'user'
    && (!config.humanRequiresRpc || 'rpcId' in message.source)
    && isRoot(agent)

  const touch = () => { lastActivity = Date.now() }

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent.inbox.nextTurn.some(m => m.id === message.id)) promptsOf(agent).add(message.id)
    if (!isHuman(agent, message)) return
    touch()
    // Fuori dal dispatch dell'inbox: i followup rimandati si accodano DOPO il
    // messaggio umano, ognuno come turno a sé.
    if (deferred.size > 0) queueMicrotask(flushDeferred)
  })

  ctx.on('agent/inbox/discarded', ({ agent, message }) => { turnPrompts.get(agent)?.delete(message.id) })

  // La fine di un turno umano conta come attività: un job che termina un
  // minuto dopo un turno lungo 20 minuti non deve risultare "in idle".
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && humanTurn.has(agent)) touch()
  })

  ctx.on('agent/disposed', ({ agent }) => { deferred.delete(agent); turnPrompts.delete(agent) })

  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, messages, turn } = payload
    // Solo i prompt di turno (followup) si possono rimandare: i contesti
    // iniettati (ora, istruzioni, catalogo skill…) si rigenerano da soli.
    const pending = promptsOf(agent)
    const prompts = messages.filter(m => pending.has(m.id))
    for (const m of messages) pending.delete(m.id)

    if (decidedTurn.get(agent) === turn) return next()
    decidedTurn.set(agent, turn)

    const kinds = [...new Set(messages.map(m => m.source.kind))].join(', ') || '(nessun messaggio)'
    const idleFor = Date.now() - lastActivity
    const tag = `turno ${turn} su ${agent.id} [${kinds}], inattivo da ${Math.round(idleFor / 1000)}s`

    if (!config.guardSubagents && !isRoot(agent)) { log.debug(`${tag}: ammesso (subagente)`); return next() }

    if (messages.some(m => isHuman(agent, m))) {
      log.debug(`${tag}: ammesso (umano)`)
      humanTurn.add(agent)
      touch()
      return next()
    }
    humanTurn.delete(agent)

    if (idleFor < idleMs) { log.debug(`${tag}: ammesso (sotto soglia)`); return next() }
    if (messages.some(m => allow.has(m.source.kind))) { log.debug(`${tag}: ammesso (allowSources)`); return next() }

    log.info(`${tag}: BLOCCATO`)
    if (config.mode === 'defer') defer(agent, prompts)
    return { kind: 'reject' }
  })

  function defer(agent, messages) {
    if (messages.length === 0) return
    const list = deferred.get(agent) ?? []
    for (const m of messages) list.push({ content: m.content, source: m.source })
    while (list.length > config.deferLimit) list.shift()
    deferred.set(agent, list)
    log.info(`${messages.length} messaggi rimandati per ${agent.id} (in coda: ${list.length})`)
  }

  function flushDeferred() {
    for (const [agent, list] of [...deferred]) {
      deferred.delete(agent)
      if (ctx.agents.get(agent.id) !== agent) continue
      for (const item of list) {
        agent.followup(createUserMessage({ content: [...item.content], source: item.source }))
      }
      log.info(`${list.length} messaggi rimandati riconsegnati a ${agent.id}`)
    }
  }
}
