// The background Claude Code session for the full-screen app: sends prompts,
// turns the SDK's messages into log entries and state, and routes permission
// requests and questions to the screen.
import {
  query,
  type CanUseTool,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { commandNames, history, syntheticText } from './commands.js'
import { withImages, type Content } from './images.js'
import { mascot, persona } from './characters.js'
import { pick } from './milo.js'
import { MODES } from './settings.js'
import { getState, push, setState, type Choice, type Diff, type Entry, type Question } from './store.js'

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

let inbox: ReturnType<typeof createInbox> | undefined

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
        tool,
        detail: summarize(input),
        reason: decisionReason,
        diff,
        canAlways,
        resolve: (choice: Choice) => {
          setState({ pending: undefined, showDiff: false })
          if (choice === 'no') {
            push({ kind: 'note', text: `Declined ${tool}`, tone: 'dim' })
            resolve({ behavior: 'deny', message: DECLINED })
          } else if (choice === 'always' && canAlways)
            resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: suggestions })
          else resolve({ behavior: 'allow', updatedInput: input })
        },
      },
    }))
  })

// --- One background session ------------------------------------------------

let session: ReturnType<typeof query> | undefined
const queued: string[] = []
// Plans with a usage limit (Pro, Max, Team, Enterprise) don't charge per token,
// so the SDK's dollar estimate only means something without a subscription.
let billedPerToken = false

/** The running session, for commands that ask it directly. */
export const current = () => session

// Also picks up a model changed with /model.
const refreshContext = () =>
  session
    ?.getContextUsage()
    .then(usage => setState({ contextPct: Math.round(usage.percentage), model: modelName(usage.model) }))
    .catch(() => {})

/** claude-opus-5-5 → Opus 5.5; anything else as given. */
const modelName = (id: string) => {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|$)/.exec(id)
  if (!match) return id
  const [, family, major, minor] = match
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}

const handle = (msg: SDKMessage) => {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        setState({ sessionId: msg.session_id, mode: msg.permissionMode, model: modelName(msg.model) })
        refreshContext()
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
        push({ kind: 'tool', id: block.id, name: block.name, detail: summarize(input), status: 'running' })
        if (block.name === 'Agent' || block.name === 'Task') {
          agentCalls.add(block.id)
          countAgents()
        }
        const diff = diffFor(block.name, input)
        setState(s => ({
          mood: 'working',
          currentTool: block.name,
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
      clearStop()
      const ms = Date.now() - getState().turnStarted
      const ok = msg.subtype === 'success'
      const outcome = ok ? `${mascot().name} ${pick(mascot().past)}` : `Stopped (${msg.subtype.replaceAll('_', ' ')})`
      const cost = billedPerToken && msg.total_cost_usd ? ` · $${msg.total_cost_usd.toFixed(2)}` : ''
      push({ kind: 'note', text: `${outcome} · ${Math.max(1, Math.round(ms / 1000))}s${cost}`, tone: ok ? 'dim' : 'error' })
      setState({ busy: false, mood: ok ? 'idle' : 'error', status: outcome, lastTurnMs: ms, currentTool: undefined })
      refreshContext()
      if (movedTo || restyled) follow()
      const next = queued.shift()
      if (next !== undefined) submit(next)
      return
    }
  }
}

export const start = (resume?: string, permissionMode?: PermissionMode) => {
  inbox = createInbox()
  const current = query({
    prompt: inbox.messages,
    options: {
      cwd: process.cwd(),
      resume,
      permissionMode,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: persona() },
      settingSources: ['user', 'project', 'local'],
      canUseTool,
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

export const close = () => {
  clearStop()
  inbox?.close()
  inbox = undefined
  session?.close()
  session = undefined
}

/** Sends a prompt; one sent while Claude is busy waits for the turn to end. */
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
  inbox?.send(prompt.content)
}

// --- Stopping a reply ------------------------------------------------------

// How long Claude Code gets to end the turn after an interrupt before Milo
// stops waiting and restarts it.
const STOP_GRACE_MS = 3000
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
export const interrupt = () => {
  if (stopTimer) return forceStop()
  queued.length = 0
  const asking = getState().pending
  if (asking?.kind === 'permission') asking.resolve('no')
  setState({ status: 'Stopping' })
  stopTimer = setTimeout(forceStop, STOP_GRACE_MS)
  session?.interrupt().catch(forceStop)
}

/** A fresh conversation, or an earlier one picked up where it left off. */
export const restart = async (resume?: string) => {
  const entries = resume ? await history(resume, summarize) : []
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
    lastDiff: undefined,
    showDiff: false,
    pending: undefined,
    sessionId: undefined,
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
  agentCalls.clear()
  tasks.clear()
  setState({ agents: 0 })
  start(sessionId, MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : undefined)
  if (moving) push({ kind: 'note', text: `Now working in ${dir}`, tone: 'dim' })
}

/** Moves Claude Code to `dir`, once any reply in progress has finished. */
export const moveTo = (dir: string) => {
  movedTo = dir
  if (getState().busy) push({ kind: 'note', text: `Moving to ${dir} once this reply ends`, tone: 'dim' })
  else follow()
}

/** Restarts Claude Code with the current mascot's personality, once any reply in progress has finished. */
export const restyle = () => {
  restyled = true
  if (getState().busy) push({ kind: 'note', text: 'The new personality starts once this reply ends.', tone: 'dim' })
  else follow()
}

export { MODES }

export const setMode = async (mode: PermissionMode) => {
  await session?.setPermissionMode(mode)
  setState({ mode })
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
