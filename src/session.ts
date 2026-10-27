// The background sessions for the full-screen app. Each one sends prompts,
// turns the SDK's messages into log entries and state in its own slot, and
// routes permission requests and questions to the screen. With an OpenAI model
// picked, its prompts go to Codex instead (see codex.ts). Several can run at
// once, each in its own folder; the exports act on the one on screen.
import {
  deleteSession,
  query,
  type CanUseTool,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { settings } from './settings.js'
import * as codex from './codex.js'
import * as delegate from './delegate.js'
import { commandNames, history, syntheticText } from './commands.js'
import { withAttachments, type Content } from './images.js'
import { mascot, persona } from './characters.js'
import { pick } from './milo.js'
import { MODES } from './settings.js'
import { activeKey, addSlot, getSlots, removeSlot, showSlot, storeFor, type Choice, type Diff, type Entry, type Question } from './store.js'

const DECLINED = 'The user declined this action.'

// --- Input queue: one long-lived session, fed a message per prompt ---------

// Each session gets its own inbox, so a closed session's generator can't
// wake up later and swallow prompts meant for the next one.
const createInbox = () => {
  const pending: SDKUserMessage[] = []
  let wake: (() => void) | undefined
  let closed = false
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (pending.length) yield pending.shift()!
      if (closed) return
      await new Promise<void>(resolve => (wake = resolve))
    }
  }
  return {
    messages: messages(),
    send: (content: Content) => {
      pending.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })
      wake?.()
    },
    close: () => {
      closed = true
      pending.length = 0
      wake?.()
    },
  }
}

// --- Helpers ---------------------------------------------------------------

const clip = (text: string, max = 90) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export const summarize = (input: Record<string, unknown>): string => {
  const key = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'].find(
    k => typeof input[k] === 'string',
  )
  return key ? clip(String(input[key])) : ''
}

const readIfSmall = (file: string) => {
  try {
    return existsSync(file) && statSync(file).size < 512 * 1024 ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

/**
 * Starts Claude Code in a session of its own, away from Milo's terminal.
 * Otherwise it can write to the terminal directly, as "[Request interrupted by
 * user]" when Milo closes it mid-reply, and that shows after Milo has left the
 * screen. Its stderr goes unread, so it's dropped rather than left to fill up.
 */
const spawnClaudeCode = ({ command, args, cwd, env, signal }: SpawnOptions) =>
  spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true })

const CONTEXT_LINES = 3

/** An edit shown where it sits in the file, with a few lines either side. */
const editInContext = (file: string, oldText: string, newText: string): Diff => {
  const content = readIfSmall(file)
  const at = oldText ? content.indexOf(oldText) : -1
  if (at < 0) return { file, before: oldText, after: newText, start: 1 }
  const lines = content.split('\n')
  const first = content.slice(0, at).split('\n').length - 1
  const last = first + oldText.split('\n').length - 1
  const from = Math.max(0, first - CONTEXT_LINES)
  const before = lines.slice(from, Math.min(lines.length, last + CONTEXT_LINES + 1)).join('\n')
  const offset = at - lines.slice(0, from).reduce((n, line) => n + line.length + 1, 0)
  const after = before.slice(0, offset) + newText + before.slice(offset + oldText.length)
  return { file, before, after, start: from + 1 }
}

/** The before and after text of a file edit, for the side-by-side view. */
const diffFor = (tool: string, input: Record<string, unknown>): Diff | undefined => {
  const file = typeof input.file_path === 'string' ? input.file_path : undefined
  if (!file) return undefined
  if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string')
    return editInContext(file, input.old_string, input.new_string)
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    const edits = input.edits as { old_string: string; new_string: string }[]
    return {
      file,
      before: edits.map(e => e.old_string).join('\n⋯\n'),
      after: edits.map(e => e.new_string).join('\n⋯\n'),
      start: 1,
    }
  }
  if (tool === 'Write' && typeof input.content === 'string')
    return { file, before: readIfSmall(file), after: input.content, start: 1 }
  return undefined
}

const toolName = (name: string) => (name === delegate.TOOL ? 'Codex agent' : name)

/** claude-opus-5-5 → Opus 5.5; anything else as given. */
const modelName = (id: string) => {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|$)/.exec(id)
  if (!match) return id
  const [, family, major, minor] = match
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}

// --- Handing the conversation across a switch ------------------------------

// Claude Code and Codex can't read each other's conversations, so a switch
// sends the new one what's on screen: prompts, replies and tool calls, newest
// first to stay when it's long.
const HANDOFF_CHARS = 8000

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

// How long Claude Code gets to end the turn after an interrupt before Milo
// stops waiting and restarts it.
const STOP_GRACE_MS = 3000

// --- One session -----------------------------------------------------------

/** A session that writes to slot `key` and works in that slot's folder. */
const createSession = (key: string) => {
  const store = storeFor(key)
  const { getState, setState, push } = store
  let inbox: ReturnType<typeof createInbox> | undefined

  const appendText = (text: string) =>
    setState(s => {
      const last = s.entries.at(-1)
      if (last?.kind === 'assistant')
        return { entries: [...s.entries.slice(0, -1), { ...last, text: last.text + text }] }
      return { entries: [...s.entries, { kind: 'assistant', text }] }
    })

  const updateTool = (id: string, patch: Partial<Extract<Entry, { kind: 'tool' }>>) =>
    setState(s => ({ entries: s.entries.map(e => (e.kind === 'tool' && e.id === id ? { ...e, ...patch } : e)) }))

  // Subagents: Agent tool calls in flight plus background tasks.
  const agentCalls = new Set<string>()
  const tasks = new Set<string>()
  const countAgents = () => setState({ agents: agentCalls.size + tasks.size })

  // --- Permissions and questions: Claude asks, the screen answers ------------

  const canUseTool: CanUseTool = (tool, input, { signal, suggestions, decisionReason }) =>
    new Promise(resolve => {
      signal.addEventListener('abort', () => {
        setState({ pending: undefined, showDiff: false })
        resolve({ behavior: 'deny', message: DECLINED })
      })

      if (tool === 'AskUserQuestion') {
        setState({
          pending: {
            kind: 'question',
            questions: (input.questions ?? []) as Question[],
            index: 0,
            answers: {},
            resolve: answers => {
              setState({ pending: undefined })
              resolve({ behavior: 'allow', updatedInput: { ...input, answers } })
            },
          },
        })
        return
      }

      const diff = diffFor(tool, input)
      const canAlways = !!suggestions?.length
      setState(s => ({
        showDiff: !!diff,
        lastDiff: diff ?? s.lastDiff,
        pending: {
          kind: 'permission',
          tool: toolName(tool),
          detail: summarize(input),
          reason: decisionReason,
          diff,
          canAlways,
          resolve: (choice: Choice) => {
            setState({ pending: undefined, showDiff: false })
            if (choice === 'no') {
              push({ kind: 'note', text: `Declined ${toolName(tool)}`, tone: 'dim' })
              resolve({ behavior: 'deny', message: DECLINED })
            } else if (choice === 'always' && canAlways)
              resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: suggestions })
            else resolve({ behavior: 'allow', updatedInput: input })
          },
        },
      }))
    })

  // --- The Claude Code session ----------------------------------------------

  let session: ReturnType<typeof query> | undefined
  // The Codex agent tool given to this session's Claude.
  let tools: ReturnType<typeof delegate.server> | undefined
  const queued: string[] = []
  // Plans with a usage limit (Pro, Max, Team, Enterprise) don't charge per token,
  // so the SDK's dollar estimate only means something without a subscription.
  let billedPerToken = false

  // Also picks up a model changed with /model.
  const refreshContext = () =>
    session
      ?.getContextUsage()
      .then(usage => setState({ contextPct: Math.round(usage.percentage), model: modelName(usage.model) }))
      .catch(() => {})

  const refreshUsage = () =>
    session
      ?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
      .then(usage => {
        const used = usage.rate_limits?.five_hour?.utilization
        if (used != null) setState({ usage: `${Math.round(used)}%` })
        else if (!usage.subscription_type) setState({ usage: `$${usage.session.total_cost_usd.toFixed(2)}` })
      })
      .catch(() => {})

  const handle = (msg: SDKMessage) => {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          setState({ sessionId: msg.session_id, mode: msg.permissionMode, model: modelName(msg.model) })
          refreshContext()
          refreshUsage()
        } else if (msg.subtype === 'task_started') {
          tasks.add(msg.task_id)
          countAgents()
        } else if (msg.subtype === 'task_notification') {
          tasks.delete(msg.task_id)
          countAgents()
        }
        return

      case 'stream_event': {
        if (msg.parent_tool_use_id) return
        const event = msg.event
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') appendText(event.delta.text)
        return
      }

      case 'assistant': {
        if (msg.parent_tool_use_id) return
        const reply = syntheticText(msg)
        if (reply) push({ kind: 'assistant', text: reply })
        for (const block of msg.message.content) {
          if (block.type !== 'tool_use') continue
          const input = block.input as Record<string, unknown>
          const diff = diffFor(block.name, input)
          const file = typeof input.file_path === 'string' ? input.file_path : undefined
          push({ kind: 'tool', id: block.id, name: toolName(block.name), detail: summarize(input), status: 'running', file, diff })
          if (block.name === 'Agent' || block.name === 'Task' || block.name === delegate.TOOL) {
            agentCalls.add(block.id)
            countAgents()
          }
          setState(s => ({
            mood: 'working',
            currentTool: toolName(block.name),
            turnTools: s.turnTools + 1,
            status: pick(mascot().verbs),
            lastDiff: diff ?? s.lastDiff,
          }))
        }
        return
      }

      case 'user': {
        if (msg.parent_tool_use_id || !Array.isArray(msg.message.content)) return
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue
          const text = typeof block.content === 'string' ? block.content : ''
          if (block.is_error && text !== DECLINED) updateTool(block.tool_use_id, { status: 'error', error: text })
          else updateTool(block.tool_use_id, { status: block.is_error ? 'error' : 'done' })
          if (agentCalls.delete(block.tool_use_id)) countAgents()
          setState({ mood: 'thinking', currentTool: undefined })
        }
        return
      }

      case 'result': {
        const cost = billedPerToken && msg.total_cost_usd ? ` · $${msg.total_cost_usd.toFixed(2)}` : ''
        endTurn(msg.subtype === 'success' ? undefined : msg.subtype.replaceAll('_', ' '), cost)
        return
      }
    }
  }

  /** A turn is over: says how it went, then moves, restyles or sends the next prompt. */
  const endTurn = (failure?: string, cost = '') => {
    clearStop()
    const ms = Date.now() - getState().turnStarted
    const outcome = failure === undefined ? `${mascot().name} ${pick(mascot().past)}` : `Stopped (${failure})`
    push({ kind: 'note', text: `${outcome} · ${Math.max(1, Math.round(ms / 1000))}s${cost}`, tone: failure === undefined ? 'dim' : 'error' })
    setState({ busy: false, mood: failure === undefined ? 'idle' : 'error', status: outcome, lastTurnMs: ms, currentTool: undefined })
    if (getState().provider === 'codex') refreshCodex()
    else {
      refreshContext()
      refreshUsage()
    }
    if (movedTo || restyled) follow()
    const next = queued.shift()
    if (next !== undefined) submit(next)
  }

  // --- Codex: OpenAI models, one turn per prompt ----------------------------

  let codexTurn: AbortController | undefined
  // undefined is Codex's own default model.
  let codexModel: string | undefined

  const refreshCodex = () => {
    const id = getState().sessionId
    const found = id ? codex.status(id) : {}
    setState(s => ({
      model: found.model ?? s.model,
      contextPct: found.contextPct ?? s.contextPct,
      usage: found.usage ?? s.usage,
    }))
  }

  const startCodex = (resume?: string) => {
    setState({ sessionId: resume, model: codexModel ? codex.modelName(codexModel) : 'Codex', commands: [] })
    if (resume) refreshCodex()
  }

  const sendCodex = (text: string, images: string[]) => {
    const turn = new AbortController()
    codexTurn = turn
    void codex
      .run({
        cwd: getState().cwd,
        store,
        threadId: getState().sessionId,
        model: codexModel,
        mode: getState().mode,
        text,
        images,
        signal: turn.signal,
        onThread: id => turn === codexTurn && setState({ sessionId: id }),
      })
      .then(end => {
        if (turn !== codexTurn) return
        codexTurn = undefined
        if (!end.ok && end.error) push({ kind: 'note', text: `Codex: ${end.error}`, tone: 'error' })
        endTurn(end.ok ? undefined : end.stopped ? 'interrupted' : 'error')
      })
  }

  const start = (resume?: string, permissionMode?: PermissionMode) => {
    if (getState().provider === 'codex') return startCodex(resume)
    inbox = createInbox()
    tools = delegate.server(store)
    const current = query({
      prompt: inbox.messages,
      options: {
        cwd: getState().cwd,
        resume,
        permissionMode,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: persona() },
        settingSources: ['user', 'project', 'local'],
        mcpServers: { codex: tools.config },
        canUseTool,
        spawnClaudeCodeProcess: spawnClaudeCode,
      },
    })
    session = current
    current
      .supportedCommands()
      .then(commands => setState({ commands: commandNames(commands) }))
      .catch(() => {})
    current
      .accountInfo()
      .then(account => (billedPerToken = !account.subscriptionType))
      .catch(() => {})
    void (async () => {
      try {
        for await (const msg of current) if (current === session) handle(msg)
      } catch (err) {
        if (current !== session) return
        push({ kind: 'note', text: `Claude Code stopped: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' })
        setState({ busy: false, mood: 'error', status: 'Claude Code stopped' })
      }
    })()
  }

  const close = () => {
    clearStop()
    codexTurn?.abort()
    codexTurn = undefined
    tools?.stopAll()
    tools = undefined
    inbox?.close()
    inbox = undefined
    session?.close()
    session = undefined
  }

  /** Sends a prompt; one sent while Claude is busy waits for the turn to end. */
  const submit = (text: string) => {
    if (getState().busy) {
      queued.push(text)
      push({ kind: 'note', text: `Queued: ${clip(text, 60)}`, tone: 'dim' })
      return
    }
    const prompt = withAttachments(text)
    push({ kind: 'user', text, images: prompt.images, files: prompt.files })
    for (const problem of prompt.problems) push({ kind: 'note', text: problem, tone: 'error' })
    setState({ busy: true, mood: 'thinking', status: pick(mascot().verbs), turnStarted: Date.now(), turnTools: 0 })
    // The first prompt after a switch carries the conversation so far.
    const before = handoff
    handoff = undefined
    if (getState().provider === 'codex') sendCodex(before ? before + text : text, prompt.images)
    else if (!before) inbox?.send(prompt.content)
    else
      inbox?.send(
        typeof prompt.content === 'string' ? before + prompt.content : [{ type: 'text', text: before }, ...prompt.content],
      )
  }

  // The conversation so far, sent with the first prompt after a switch.
  let handoff: string | undefined

  // --- Stopping a reply ------------------------------------------------------

  let stopTimer: NodeJS.Timeout | undefined

  const clearStop = () => {
    clearTimeout(stopTimer)
    stopTimer = undefined
  }

  /** Abandons a turn that won't end: restarts Claude Code on the same conversation. */
  const forceStop = () => {
    clearStop()
    if (!getState().busy) return
    const id = getState().sessionId
    close()
    queued.length = 0
    agentCalls.clear()
    tasks.clear()
    push({ kind: 'note', text: "Claude Code didn't stop, so Milo restarted it.", tone: 'error' })
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

  /** Asks Claude Code to stop; asking again, or no answer in time, forces it. */
  const interrupt = () => {
    if (stopTimer) return forceStop()
    queued.length = 0
    const asking = getState().pending
    if (asking?.kind === 'permission') asking.resolve('no')
    setState({ status: 'Stopping' })
    stopTimer = setTimeout(forceStop, STOP_GRACE_MS)
    if (codexTurn) codexTurn.abort()
    else session?.interrupt().catch(forceStop)
  }

  /**
   * A fresh conversation, or an earlier Claude Code one picked up where it left
   * off; resuming one goes back to Claude.
   */
  const restart = async (resume?: string) => {
    const entries = resume ? await history(resume, summarize, getState().cwd) : []
    if (resume) setState({ provider: 'claude' })
    handoff = undefined
    // Keep the mode the user picked; a new session would start in the default.
    const mode = getState().mode as PermissionMode
    close()
    queued.length = 0
    agentCalls.clear()
    tasks.clear()
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
      // Known now, not only once Claude Code first answers, so the sessions
      // list doesn't offer the same conversation again as a saved one.
      sessionId: resume,
    })
    start(resume, MODES.includes(mode) ? mode : undefined)
  }

  // --- Following the command line's folder, and a new personality ----------

  // Claude Code's working folder and system prompt are fixed when it starts, so
  // a new folder or mascot means restarting it on the same conversation.
  // Mid-turn, that waits for the turn to end.
  let movedTo: string | undefined
  let restyled = false

  const follow = () => {
    const dir = movedTo
    movedTo = undefined
    const moving = !!dir && dir !== getState().cwd
    if (!moving && !restyled) return
    if (moving)
      try {
        if (!statSync(dir).isDirectory()) throw new Error('not a folder')
        if (activeKey() === key) process.chdir(dir)
        setState({ cwd: dir })
      } catch (err) {
        push({ kind: 'note', text: `Couldn't move to ${dir}: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' })
        return
      }
    restyled = false
    const { sessionId, mode } = getState()
    close()
    agentCalls.clear()
    tasks.clear()
    setState({ agents: 0 })
    start(sessionId, MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : undefined)
    if (moving) push({ kind: 'note', text: `Now working in ${dir}`, tone: 'dim' })
  }

  /** Moves Claude Code to `dir`, once any reply in progress has finished. */
  const moveTo = (dir: string) => {
    movedTo = dir
    if (getState().busy) push({ kind: 'note', text: `Moving to ${dir} once this reply ends`, tone: 'dim' })
    else follow()
  }

  /** Restarts Claude Code with the current mascot's personality, once any reply in progress has finished. */
  const restyle = () => {
    restyled = true
    if (getState().busy) push({ kind: 'note', text: 'The new personality starts once this reply ends.', tone: 'dim' })
    else follow()
  }

  const setMode = async (mode: PermissionMode) => {
    // Codex picks its sandbox from the mode at the start of each turn.
    if (getState().provider === 'claude') await session?.setPermissionMode(mode)
    setState({ mode })
  }

  /**
   * Switches model. An OpenAI one ("codex" for Codex's default) moves to Codex,
   * and a Claude one moves back; either move starts a fresh conversation.
   * Returns false for a Claude model while on Claude, which /model handles itself.
   */
  const useModel = async (name: string): Promise<boolean> => {
    const toCodex = codex.isCodexModel(name)
    const from = getState().provider
    if (!toCodex && from === 'claude') return false
    if (toCodex) codexModel = name.toLowerCase() === 'codex' ? undefined : name
    if (toCodex && from === 'codex') {
      setState({ model: codexModel ? codex.modelName(codexModel) : 'Codex' })
      push({ kind: 'note', text: `Codex now uses ${getState().model}.`, tone: 'dim' })
      return true
    }
    const kept = getState().entries
    setState({ provider: toCodex ? 'codex' : 'claude', model: '' })
    await restart()
    if (!toCodex) await session?.setModel(name).catch(() => push({ kind: 'note', text: `Claude Code doesn't know ${name}.`, tone: 'error' }))
    refreshContext()
    // The conversation stays on screen, and goes along with the next prompt.
    handoff = handoffFrom(kept, from === 'codex' ? 'Codex' : 'Claude Code')
    const now = !toCodex ? 'Back to Claude Code.' : codexModel ? `Now talking to ${getState().model} through Codex.` : 'Now talking to Codex.'
    setState(s => ({
      entries: [...kept, ...s.entries, { kind: 'note', text: handoff ? `${now} It gets the conversation so far with your next message.` : now, tone: 'dim' }],
    }))
    return true
  }

  /** Shift+Tab: the next permission mode, skipping any this account can't use. */
  const cycleMode = async () => {
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

  return { current: () => session, start, close, submit, interrupt, restart, moveTo, restyle, setMode, useModel, cycleMode }
}

type Session = ReturnType<typeof createSession>

// --- Every open session ----------------------------------------------------

const sessions = new Map<string, Session>(getSlots().map(slot => [slot.key, createSession(slot.key)]))
const active = () => sessions.get(activeKey())!

export { MODES }

/** The running Claude Code session on screen, for commands that ask it directly. */
export const current = () => active().current()
export const start = (resume?: string, permissionMode?: PermissionMode) => active().start(resume, permissionMode)
export const submit = (text: string) => active().submit(text)
export const interrupt = () => active().interrupt()
export const restart = (resume?: string) => active().restart(resume)
export const moveTo = (dir: string) => active().moveTo(dir)
export const setMode = (mode: PermissionMode) => active().setMode(mode)
export const useModel = (name: string) => active().useModel(name)
export const cycleMode = () => active().cycleMode()
/** Every session takes on the current mascot's personality. */
export const restyle = () => sessions.forEach(session => session.restyle())
export const closeAll = () => sessions.forEach(session => session.close())

/** Puts slot `key` on screen, and moves Milo into its folder. */
export const show = (key: string) => {
  showSlot(key)
  try {
    process.chdir(storeFor(key).getState().cwd)
  } catch {
    // The folder has gone; the session still shows.
  }
}

/**
 * Opens another session in `cwd`, alongside the rest, and shows it: a fresh
 * conversation, or a saved Claude Code one picked up where it left off.
 */
export const open = async (cwd: string, resume?: string) => {
  const already = resume && getSlots().find(slot => slot.state.sessionId === resume)
  if (already) {
    show(already.key)
    return already.key
  }
  const mode = storeFor(activeKey()).getState().mode as PermissionMode
  const key = addSlot(cwd, { mode: MODES.includes(mode) ? mode : (settings.defaultMode ?? 'default') })
  const session = createSession(key)
  sessions.set(key, session)
  show(key)
  await session.restart(resume)
  return key
}

/** Stops and forgets slot `key`; the last one can't go. */
export const closeSession = (key: string) => {
  const session = sessions.get(key)
  if (!session || sessions.size < 2) return false
  session.close()
  sessions.delete(key)
  const wasShown = activeKey() === key
  removeSlot(key)
  if (wasShown) show(activeKey())
  return true
}

/**
 * Deletes a conversation for good. An open one is closed first, so Claude Code
 * stops writing to it; the last open one becomes a fresh conversation instead.
 */
export const remove = async ({ key, sessionId, dir }: { key?: string; sessionId?: string; dir?: string }) => {
  const open = getSlots().find(slot => (key ? slot.key === key : !!sessionId && slot.state.sessionId === sessionId))
  if (open) {
    const was = open.state
    if (!closeSession(open.key)) await sessions.get(open.key)!.restart()
    // A stopped Claude Code can take a moment to finish writing its file.
    if (was.busy) await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (sessionId) await deleteSession(sessionId, { dir })
}
