// Milo's harness for the full-screen app: runs the conversation with whichever
// provider is active (Claude Code, or OpenAI's models through Codex), turns
// what it reports into log entries and state, asks the user before actions,
// and decides what happens between turns: queued prompts, handing the
// conversation across a switch, stopping, and following a new folder or
// personality.
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import * as codex from './codex.js'
import { history } from './commands.js'
import { withImages } from './images.js'
import { mascot } from './characters.js'
import { pick } from './milo.js'
import { MODES } from './settings.js'
import { getState, push, setState, type Entry } from './store.js'
import { clip, summarize, type Host, type Provider, type ProviderEvent, type StartOptions } from './provider.js'
import { startClaude, type ClaudeProvider } from './providers/claude.js'
import { startCodex } from './providers/codex.js'

let active: Provider | undefined
const queued: string[] = []
// The OpenAI model Codex starts with; undefined is Codex's own default.
let codexModel: string | undefined

/** The running Claude Code session, for commands that ask it directly. */
export const current = () => (active?.id === 'claude' ? (active as ClaudeProvider).query : undefined)

// --- What providers report, on screen --------------------------------------

const appendText = (text: string) =>
  setState(s => {
    const last = s.entries.at(-1)
    if (last?.kind === 'assistant')
      return { entries: [...s.entries.slice(0, -1), { ...last, text: last.text + text }] }
    return { entries: [...s.entries, { kind: 'assistant', text }] }
  })

/** Adds a tool call to the log, or updates one already there. */
const showTool = (event: Extract<ProviderEvent, { type: 'tool' }>) =>
  setState(s => {
    const { id, status, name, detail, error, diff } = event
    const lastDiff = diff ?? s.lastDiff
    const settled = status !== 'running' ? { mood: 'thinking' as const, currentTool: undefined } : {}
    if (s.entries.some(e => e.kind === 'tool' && e.id === id)) {
      const entries = s.entries.map(e =>
        e.kind === 'tool' && e.id === id
          ? { ...e, status, error, ...(name !== undefined && { name }), ...(detail !== undefined && { detail }) }
          : e,
      )
      return { entries, lastDiff, ...settled }
    }
    if (name === undefined) return {}
    const entry: Entry = { kind: 'tool', id, name, detail: detail ?? '', status, error }
    return {
      entries: [...s.entries, entry],
      mood: 'working',
      currentTool: name,
      turnTools: s.turnTools + 1,
      status: pick(mascot().verbs),
      lastDiff,
      ...settled,
    }
  })

const onEvent = (label: string, event: ProviderEvent) => {
  switch (event.type) {
    case 'session':
      return setState({ sessionId: event.id })
    case 'header': {
      const { type: _, ...header } = event
      return setState(Object.fromEntries(Object.entries(header).filter(([, v]) => v !== undefined)))
    }
    case 'commands':
      return setState({ commands: event.names })
    case 'text':
      return appendText(event.text)
    case 'reply':
      return push({ kind: 'assistant', text: event.text })
    case 'tool':
      return showTool(event)
    case 'agents':
      return setState({ agents: event.count })
    case 'note':
      return push({ kind: 'note', text: event.text, tone: event.tone })
    case 'end':
      return endTurn(event.failure, event.cost)
    case 'crash':
      push({ kind: 'note', text: `${label} stopped: ${event.message}`, tone: 'error' })
      return setState({ busy: false, mood: 'error', status: `${label} stopped` })
  }
}

// --- Asking the user: one place for every provider ------------------------

// Each start gets a token, so a closed provider's late events are ignored,
// while one still starting can already report.
let started: object | undefined

const hostFor = (token: object, label: string): Host => ({
  emit: event => {
    if (token === started) onEvent(label, event)
  },
  approve: (request, signal) =>
    new Promise(resolve => {
      signal.addEventListener('abort', () => {
        setState({ pending: undefined, showDiff: false })
        resolve('no')
      })
      setState(s => ({
        showDiff: !!request.diff,
        lastDiff: request.diff ?? s.lastDiff,
        pending: {
          kind: 'permission',
          ...request,
          resolve: choice => {
            setState({ pending: undefined, showDiff: false })
            if (choice === 'no') push({ kind: 'note', text: `Declined ${request.tool}`, tone: 'dim' })
            resolve(choice)
          },
        },
      }))
    }),
  ask: (questions, signal) =>
    new Promise(resolve => {
      signal.addEventListener('abort', () => {
        setState({ pending: undefined })
        resolve(undefined)
      })
      setState({
        pending: {
          kind: 'question',
          questions,
          index: 0,
          answers: {},
          resolve: answers => {
            setState({ pending: undefined })
            resolve(answers)
          },
        },
      })
    }),
})

// --- The loop: start, send, end each turn ---------------------------------

export const start = (resume?: string, mode?: PermissionMode) => {
  const token = {}
  started = token
  const options: StartOptions = { resume, mode, model: codexModel }
  // Codex has no mode of its own to report, so it takes the one on screen.
  active =
    getState().provider === 'codex'
      ? startCodex(hostFor(token, 'Codex'), { ...options, mode: mode ?? (getState().mode as PermissionMode) })
      : startClaude(hostFor(token, 'Claude Code'), options)
}

export const close = () => {
  clearStop()
  const closing = active
  active = undefined
  started = undefined
  closing?.close()
}

/** A turn is over: says how it went, then moves, restyles or sends the next prompt. */
const endTurn = (failure?: string, cost = '') => {
  clearStop()
  const ms = Date.now() - getState().turnStarted
  const outcome = failure === undefined ? `${mascot().name} ${pick(mascot().past)}` : `Stopped (${failure})`
  push({ kind: 'note', text: `${outcome} · ${Math.max(1, Math.round(ms / 1000))}s${cost}`, tone: failure === undefined ? 'dim' : 'error' })
  setState({ busy: false, mood: failure === undefined ? 'idle' : 'error', status: outcome, lastTurnMs: ms, currentTool: undefined })
  active?.refresh()
  if (movedTo || restyled) follow()
  const next = queued.shift()
  if (next !== undefined) submit(next)
}

/** Sends a prompt; one sent while the provider is busy waits for the turn to end. */
export const submit = (text: string) => {
  if (getState().busy) {
    queued.push(text)
    push({ kind: 'note', text: `Queued: ${clip(text, 60)}`, tone: 'dim' })
    return
  }
  const prompt = withImages(text)
  push({ kind: 'user', text, images: prompt.images })
  for (const problem of prompt.problems) push({ kind: 'note', text: problem, tone: 'error' })
  setState({ busy: true, mood: 'thinking', status: pick(mascot().verbs), turnStarted: Date.now(), turnTools: 0 })
  // The first prompt after a switch carries the conversation so far.
  const before = handoff ?? ''
  handoff = undefined
  active?.send({
    text: before + text,
    content: !before
      ? prompt.content
      : typeof prompt.content === 'string'
        ? before + prompt.content
        : [{ type: 'text', text: before }, ...prompt.content],
    images: prompt.images,
  })
}

// --- Handing the conversation across a switch ------------------------------

// Providers can't read each other's conversations, so a switch sends the new
// one what's on screen: prompts, replies and tool calls, newest first to stay
// when it's long.
const HANDOFF_CHARS = 8000
let handoff: string | undefined

const transcript = (entries: Entry[]) => {
  const lines: string[] = []
  let size = 0
  for (const e of [...entries].reverse()) {
    const line =
      e.kind === 'user'
        ? `User: ${e.text}`
        : e.kind === 'assistant'
          ? `Assistant: ${clip(e.text, 600)}`
          : e.kind === 'tool'
            ? `  (${e.name} ${e.detail}${e.status === 'error' ? ', failed' : ''})`
            : undefined
    if (!line) continue
    if (size + line.length > HANDOFF_CHARS) break
    lines.unshift(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

const handoffFrom = (entries: Entry[], from: string) => {
  const earlier = transcript(entries)
  if (!earlier) return undefined
  return [
    `This conversation started with ${from} in this folder. Here is what happened so far, for context; the user's new message follows it.`,
    '<earlier-conversation>',
    earlier,
    '</earlier-conversation>',
    '',
    '',
  ].join('\n')
}

// --- Stopping a reply ------------------------------------------------------

// How long the provider gets to end the turn after an interrupt before Milo
// stops waiting and restarts it.
const STOP_GRACE_MS = 3000
let stopTimer: NodeJS.Timeout | undefined

const clearStop = () => {
  clearTimeout(stopTimer)
  stopTimer = undefined
}

/** Abandons a turn that won't end: restarts the provider on the same conversation. */
const forceStop = () => {
  clearStop()
  if (!getState().busy) return
  const id = getState().sessionId
  const label = active?.label ?? 'Claude Code'
  close()
  queued.length = 0
  push({ kind: 'note', text: `${label} didn't stop, so Milo restarted it.`, tone: 'error' })
  setState({
    busy: false,
    mood: 'idle',
    status: 'Stopped',
    agents: 0,
    currentTool: undefined,
    pending: undefined,
    showDiff: false,
  })
  start(id)
}

/** Asks the provider to stop; asking again, or no answer in time, forces it. */
export const interrupt = () => {
  if (stopTimer) return forceStop()
  queued.length = 0
  const asking = getState().pending
  if (asking?.kind === 'permission') asking.resolve('no')
  setState({ status: 'Stopping' })
  stopTimer = setTimeout(forceStop, STOP_GRACE_MS)
  active?.interrupt().catch(forceStop)
}

/**
 * A fresh conversation, or an earlier Claude Code one picked up where it left
 * off; resuming one goes back to Claude.
 */
export const restart = async (resume?: string) => {
  const entries = resume ? await history(resume, summarize) : []
  if (resume) setState({ provider: 'claude' })
  handoff = undefined
  // Keep the mode the user picked; a new session would start in the default.
  const mode = getState().mode as PermissionMode
  close()
  queued.length = 0
  setState({
    entries: resume ? [...entries, { kind: 'note', text: 'Resumed this conversation.', tone: 'dim' }] : [],
    busy: false,
    mood: 'idle',
    status: resume ? 'Resumed' : 'Fresh start',
    agents: 0,
    contextPct: undefined,
    usage: undefined,
    lastDiff: undefined,
    showDiff: false,
    pending: undefined,
    sessionId: undefined,
  })
  start(resume, MODES.includes(mode) ? mode : undefined)
}

// --- Following the command line's folder, and a new personality ----------

// A provider's working folder and instructions are fixed when it starts, so
// a new folder or mascot means restarting it on the same conversation.
// Mid-turn, that waits for the turn to end.
let movedTo: string | undefined
let restyled = false

const follow = () => {
  const dir = movedTo
  movedTo = undefined
  const moving = !!dir && dir !== process.cwd()
  if (!moving && !restyled) return
  if (moving)
    try {
      process.chdir(dir)
    } catch (err) {
      push({ kind: 'note', text: `Couldn't move to ${dir}: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' })
      return
    }
  restyled = false
  const { sessionId, mode } = getState()
  close()
  setState({ agents: 0 })
  start(sessionId, MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : undefined)
  if (moving) push({ kind: 'note', text: `Now working in ${dir}`, tone: 'dim' })
}

/** Moves the provider to `dir`, once any reply in progress has finished. */
export const moveTo = (dir: string) => {
  movedTo = dir
  if (getState().busy) push({ kind: 'note', text: `Moving to ${dir} once this reply ends`, tone: 'dim' })
  else follow()
}

/** Restarts the provider with the current mascot's personality, once any reply in progress has finished. */
export const restyle = () => {
  restyled = true
  if (getState().busy) push({ kind: 'note', text: 'The new personality starts once this reply ends.', tone: 'dim' })
  else follow()
}

export { MODES }

export const setMode = async (mode: PermissionMode) => {
  await active?.setMode(mode)
  setState({ mode })
}

/**
 * Switches model. An OpenAI one ("codex" for Codex's default) moves to Codex,
 * and a Claude one moves back; either move starts a fresh conversation.
 * Returns false for a Claude model while on Claude, which /model handles itself.
 */
export const useModel = async (name: string): Promise<boolean> => {
  const toCodex = codex.isCodexModel(name)
  const from = getState().provider
  if (!toCodex && from === 'claude') return false
  if (toCodex) codexModel = name.toLowerCase() === 'codex' ? undefined : name
  if (toCodex && from === 'codex') {
    await active?.setModel(name)
    push({ kind: 'note', text: `Codex now uses ${getState().model}.`, tone: 'dim' })
    return true
  }
  const kept = getState().entries
  const label = active?.label ?? 'Claude Code'
  setState({ provider: toCodex ? 'codex' : 'claude', model: '' })
  await restart()
  if (!toCodex) await active?.setModel(name).catch(() => push({ kind: 'note', text: `Claude Code doesn't know ${name}.`, tone: 'error' }))
  active?.refresh()
  // The conversation stays on screen, and goes along with the next prompt.
  handoff = handoffFrom(kept, label)
  const now = !toCodex ? 'Back to Claude Code.' : codexModel ? `Now talking to ${getState().model} through Codex.` : 'Now talking to Codex.'
  setState(s => ({
    entries: [...kept, ...s.entries, { kind: 'note', text: handoff ? `${now} It gets the conversation so far with your next message.` : now, tone: 'dim' }],
  }))
  return true
}

/** Shift+Tab: the next permission mode, skipping any this account can't use. */
export const cycleMode = async () => {
  const from = MODES.indexOf(getState().mode as PermissionMode)
  for (let step = 1; step < MODES.length; step++) {
    const mode = MODES[(from + step) % MODES.length]!
    try {
      await setMode(mode)
      return
    } catch {
      // Not available here: try the next one.
    }
  }
}
