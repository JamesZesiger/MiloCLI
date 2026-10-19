// OpenAI models through the Codex CLI and the ChatGPT sign-in it keeps in
// ~/.codex. Each prompt is one Codex turn on a thread, started fresh, so the
// folder, mode and personality in use when it's sent are the ones it gets.
import { Codex, type SandboxMode, type ThreadItem } from '@openai/codex-sdk'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { persona } from './characters.js'

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

// Codex wraps each command in /bin/bash -lc '…'; this is just the command.
export const commandText = (command: string) =>
  command.replace(/^\S*\/(?:ba|z)?sh -lc '([\s\S]*)'$/, '$1').replaceAll(`'\\''`, `'`)

export type TurnEnd = { ok: true } | { ok: false; stopped: boolean; error?: string }

/**
 * Sends one prompt to Codex and passes what it does to `show` until the turn
 * ends. An agent working for Claude passes its own instructions and sandbox.
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
  show: (item: ThreadItem, done: boolean) => void
}): Promise<TurnEnd> => {
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
          options.show(event.item, false)
          break
        case 'item.completed':
          options.show(event.item, true)
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
  }
}
