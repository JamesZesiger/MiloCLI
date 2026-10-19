// OpenAI models through the Codex CLI and the ChatGPT sign-in it keeps in
// ~/.codex. Each prompt is one Codex turn on a thread, started fresh, so the
// folder, mode and personality in use when it's sent are the ones it gets.
import { Codex, type SandboxMode, type ThreadItem } from '@openai/codex-sdk'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { mascot, persona } from './characters.js'
import { pick } from './milo.js'
import { push, setState, type Diff, type Entry } from './store.js'

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')

// --- Models ----------------------------------------------------------------

type CachedModel = { slug: string; display_name?: string; visibility?: string }

/** The models Codex lists for this account, from the cache the CLI keeps. */
const cachedModels = (): CachedModel[] => {
  try {
    const cache = JSON.parse(readFileSync(join(CODEX_HOME, 'models_cache.json'), 'utf8')) as { models?: CachedModel[] }
    return cache.models ?? []
  } catch {
    return []
  }
}

export const codexModels = () => cachedModels().filter(m => m.visibility !== 'hide')

/** "codex" (Codex's own default), a model Codex lists, or anything named like an OpenAI one. */
export const isCodexModel = (name: string) => {
  const wanted = name.toLowerCase()
  return wanted === 'codex' || cachedModels().some(m => m.slug === wanted) || /^(gpt|o\d|codex)/.test(wanted)
}

/** gpt-5.6-sol → GPT-5.6-Sol; anything Codex doesn't list as given. */
export const modelName = (slug: string) => cachedModels().find(m => m.slug === slug)?.display_name ?? slug

// --- Modes -----------------------------------------------------------------

// Codex can't ask before each action, so each of Milo's modes picks a sandbox
// instead: Plan only reads, Auto has the run of the machine.
const SANDBOX: Record<string, SandboxMode> = {
  default: 'workspace-write',
  acceptEdits: 'workspace-write',
  plan: 'read-only',
  auto: 'danger-full-access',
}

const PLAN = 'Plan mode is on: look around and propose a plan, but change nothing until the user switches modes.'

// --- Header numbers, from the thread's log ---------------------------------

const logs = new Map<string, string>()

/** The log Codex writes for a thread: ~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl */
const findLog = (id: string, dir = join(CODEX_HOME, 'sessions')): string | undefined => {
  if (logs.has(id)) return logs.get(id)
  let names: string[]
  try {
    names = readdirSync(dir).sort().reverse()
  } catch {
    return undefined
  }
  for (const name of names) {
    const path = join(dir, name)
    const found = name.endsWith(`-${id}.jsonl`) ? path : statSync(path).isDirectory() ? findLog(id, path) : undefined
    if (found) {
      logs.set(id, found)
      return found
    }
  }
  return undefined
}

type TokenCount = {
  info?: { last_token_usage?: { total_tokens?: number }; model_context_window?: number } | null
  rate_limits?: { primary?: { used_percent?: number } | null } | null
}

/** The model, context used and 5-hour plan usage as of the thread's last turn. */
export const status = (id: string): { model?: string; contextPct?: number; usage?: string } => {
  const log = findLog(id)
  if (!log) return {}
  const found: { model?: string; contextPct?: number; usage?: string } = {}
  const lines = readFileSync(log, 'utf8').trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0 && (!found.model || found.usage === undefined); i--) {
    const line = lines[i]!
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) continue
    try {
      const { type, payload } = JSON.parse(line) as { type: string; payload: { type?: string; model?: string } & TokenCount }
      if (type === 'turn_context' && !found.model && payload.model) found.model = modelName(payload.model)
      if (payload.type !== 'token_count' || found.usage !== undefined) continue
      const used = payload.rate_limits?.primary?.used_percent
      const window = payload.info?.model_context_window
      const tokens = payload.info?.last_token_usage?.total_tokens
      if (used != null) found.usage = `${Math.round(used)}%`
      if (window && tokens != null) found.contextPct = Math.round((tokens / window) * 100)
    } catch {
      // A line cut off mid-write: skip it.
    }
  }
  return found
}

// --- One turn ----------------------------------------------------------------

const clip = (text: string, max = 90) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const readIfSmall = (file: string) => {
  try {
    return existsSync(file) && statSync(file).size < 512 * 1024 ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

/** Codex only says which files changed, so the change shown is since the last commit. */
const diffSinceCommit = (file: string): Diff => {
  const committed = spawnSync('git', ['show', `HEAD:./${relative(process.cwd(), file)}`], { encoding: 'utf8' })
  return { file, before: committed.status === 0 ? committed.stdout : '', after: readIfSmall(file), start: 1 }
}

const tool = (id: string, name: string, detail: string, status: 'running' | 'done' | 'error', error?: string) =>
  setState(s => {
    const entry: Entry = { kind: 'tool', id, name, detail, status, error }
    const at = s.entries.findIndex(e => e.kind === 'tool' && e.id === id)
    if (at >= 0) return { entries: s.entries.map((e, i) => (i === at ? entry : e)) }
    return {
      entries: [...s.entries, entry],
      mood: 'working',
      currentTool: name,
      turnTools: s.turnTools + 1,
      status: pick(mascot().verbs),
    }
  })

// Codex wraps each command in /bin/bash -lc '…'; this is just the command.
export const commandText = (command: string) =>
  command.replace(/^\S*\/(?:ba|z)?sh -lc '([\s\S]*)'$/, '$1').replaceAll(`'\\''`, `'`)

/** Puts what Codex is doing in the log, as if Claude were doing it. */
const show = (item: ThreadItem, done: boolean) => {
  switch (item.type) {
    case 'agent_message':
      if (done && item.text) push({ kind: 'assistant', text: item.text })
      return
    case 'command_execution': {
      const failed = item.status === 'failed' || (item.exit_code ?? 0) !== 0
      const output = item.aggregated_output.trim().split('\n').slice(-5).join('\n')
      tool(item.id, 'Bash', clip(commandText(item.command)), !done ? 'running' : failed ? 'error' : 'done', failed && done ? output : undefined)
      if (done) setState({ mood: 'thinking', currentTool: undefined })
      return
    }
    case 'file_change': {
      const files = item.changes.map(change => change.path)
      tool(item.id, 'Edit', clip(files.map(f => relative(process.cwd(), f) || f).join(', ')), item.status === 'failed' ? 'error' : 'done')
      const updated = item.changes.find(change => change.kind !== 'delete')
      if (updated) setState({ lastDiff: diffSinceCommit(updated.path) })
      setState({ mood: 'thinking', currentTool: undefined })
      return
    }
    case 'mcp_tool_call':
      tool(item.id, `${item.server}.${item.tool}`, '', !done ? 'running' : item.status === 'failed' ? 'error' : 'done', item.error?.message)
      return
    case 'web_search':
      tool(item.id, 'WebSearch', clip(item.query), done ? 'done' : 'running')
      return
    case 'error':
      push({ kind: 'note', text: item.message, tone: 'error' })
      return
  }
}

export type TurnEnd = { ok: true } | { ok: false; stopped: boolean; error?: string }

/**
 * Sends one prompt to Codex and shows what it does until the turn ends. An
 * agent working for Claude passes its own instructions, sandbox and `show`.
 */
export const run = async (options: {
  threadId?: string
  model?: string
  mode: string
  sandbox?: SandboxMode
  instructions?: string
  text: string
  images: string[]
  signal: AbortSignal
  onThread: (id: string) => void
  show?: (item: ThreadItem, done: boolean) => void
}): Promise<TurnEnd> => {
  const display = options.show ?? show
  const instructions = [options.instructions ?? persona(), options.mode === 'plan' ? PLAN : ''].filter(Boolean).join('\n\n')
  const codex = new Codex({ config: { developer_instructions: instructions } })
  const threadOptions = {
    model: options.model,
    sandboxMode: options.sandbox ?? SANDBOX[options.mode] ?? 'workspace-write',
    approvalPolicy: 'never' as const,
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
  }
  const thread = options.threadId ? codex.resumeThread(options.threadId, threadOptions) : codex.startThread(threadOptions)
  const input = options.images.length
    ? [{ type: 'text' as const, text: options.text }, ...options.images.map(path => ({ type: 'local_image' as const, path }))]
    : options.text
  try {
    const { events } = await thread.runStreamed(input, { signal: options.signal })
    for await (const event of events) {
      switch (event.type) {
        case 'thread.started':
          options.onThread(event.thread_id)
          break
        case 'item.started':
        case 'item.updated':
          display(event.item, false)
          break
        case 'item.completed':
          display(event.item, true)
          break
        case 'turn.completed':
          return { ok: true }
        case 'turn.failed':
          return { ok: false, stopped: false, error: event.error.message }
        case 'error':
          return { ok: false, stopped: false, error: event.message }
      }
    }
    return { ok: true }
  } catch (err) {
    if (options.signal.aborted) return { ok: false, stopped: true }
    return { ok: false, stopped: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    // Anything still running when the turn ended didn't finish.
    if (!options.show)
      setState(s => ({
        entries: s.entries.map(e => (e.kind === 'tool' && e.status === 'running' ? { ...e, status: 'error' } : e)),
        currentTool: undefined,
      }))
  }
}
