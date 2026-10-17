# dsh-idle-guard

Plugin per DeepSeek Harness (scritto contro **dsh 0.2.0-rc.2**, verificato con **0.2.1-rc.2**) che blocca i turni
non avviati da un umano quando l'utente è inattivo da più di `idleSeconds`.

## Come decide

- **Turno umano**: il primo step reclama un messaggio con `source.kind === 'user'`
  indirizzato a un agente *root* (lo stesso criterio di `hasDirectHumanInput` in
  `goal/tool-goal`). Passa sempre, con tutti i suoi step.
- **Turno non umano** (`schedule`, `webhook`, `hooks-*`, `tool-jobs`, `goal`,
  `subagent-settled`, `team-message`…): se l'ultima attività umana è più vecchia
  di `idleSeconds` e nessuna sorgente è in `allowSources`, il turno viene
  rifiutato in `agent/pre-step`. Il loop lo chiude con reason `blocked` senza
  alcuna richiesta al modello.
- **Attività** = inserimento in inbox di un messaggio umano, oppure fine (idle)
  di un turno umano. Anche l'avvio di dsh conta come attività.
- Gli agenti non-root (subagenti) non vengono bloccati, salvo `guardSubagents: true`.

## Configurazione

| Campo | Default | Significato |
|---|---|---|
| `idleSeconds` | `600` | Soglia di inattività |
| `mode` | `drop` | `drop` scarta i messaggi bloccati; `defer` li riconsegna come turni separati al prossimo input umano |
| `allowSources` | `[]` | `source.kind` sempre ammessi (es. `goal`, `tool-jobs`, `subagent-settled`) |
| `humanRequiresRpc` | `false` | Conta come umano solo l'input con `rpcId` (Web UI / API), non ACP/SDK/headless |
| `guardSubagents` | `false` | Applica il blocco anche ai subagenti |
| `deferLimit` | `10` | Messaggi rimandati per agente (tiene i più recenti) |
| `debug` | `false` | Stampa su console ogni decisione presa al primo step di un turno |
| `logToConsole` | `true` | Scrive anche su console. Serve nel profilo web, dove nessun exporter stampa `ctx.logger`; su profili CLI con exporter console mettilo a `false` per evitare doppioni |

Per cambiarli, ridefinisci l'intera riga nel `cordis.patch.yml` del profilo:

```yaml
- insert:
    - id: idle-guard
      name: dsh-idle-guard
      config:
        idleSeconds: 900
        mode: defer
        allowSources: [goal, tool-jobs]
        humanRequiresRpc: false
        guardSubagents: false
        deferLimit: 5
```

## Installazione

```sh
dsh plugin --profile web add ~/Progetti/dsh-idle-guard
dsh --profile web --dump-config | grep -A8 idle-guard
```

Rimozione: `dsh plugin --profile web remove dsh-idle-guard`.

## Limiti noti

- Un messaggio rifiutato in `pre-step` termina lì (non torna nell'inbox): in
  `drop` è perso. In `defer` viene ricreato con un nuovo id e la stessa sorgente.
- `goal`: se blocchi un round, il goal-round-driver potrebbe non ripartire da
  solo (il turno chiude `blocked`, che il driver non gestisce esplicitamente).
  Se usi `/goal` lasciandolo lavorare da solo, mettilo in `allowSources`.
- In `defer`, se i turni riconsegnati durano a lungo e nel frattempo torni inattivo, quelli ancora in coda vengono rimandati di nuovo al prossimo input umano: non spariscono, aspettano.
- `defer` di un round `goal` rischia di essere scartato dal driver come
  prenotazione non più valida.
- Le chiamate al modello fatte fuori da un `Agent` (es. eventuale generazione
  titoli) non passano da `agent/pre-step` e non sono coperte.

## Test

```sh
npm install && npm test
```

I test simulano il bus eventi con le firme di 0.2.0-rc.2 (invariate in 0.2.1-rc.2) (`agent/pre-step`,
`inbox.nextTurn`, `{ kind: 'reject' }`): validano la logica, non il contratto con
dsh. Dopo ogni aggiornamento di dsh rifai la prova reale (soglia bassa + job in
background) e controlla che compaia la riga `BLOCCATO`.
