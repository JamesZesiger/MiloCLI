// Claude Code as a provider: one long-lived Agent SDK session, fed a message
// per prompt. Its messages become events, and its permission requests and
// questions go to Milo to ask the user.
import { query, type CanUseTool, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, readFileSync, statSync } from 'node:fs'
import * as delegate from '../delegate.js'
import { commandNames, syntheticText } from '../commands.js'
import type { Content } from '../images.js'
import { persona } from '../characters.js'
import type { Diff, Question } from '../store.js'
import { summarize, type Host, type Provider, type StartOptions } from '../provider.js'

export const DECLINED = 'The user declined this action.'

// --- Input queue -----------------------------------------------------------

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

// --- Diffs -----------------------------------------------------------------

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

const toolName = (name: string) => (name === delegate.TOOL ? 'Codex agent' : name)

/** claude-opus-5-5 → Opus 5.5; anything else as given. */
const modelName = (id: string) => {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|$)/.exec(id)
  if (!match) return id
  const [, family, major, minor] = match
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}

// --- The provider ----------------------------------------------------------

export type ClaudeProvider = Provider & { readonly query: ReturnType<typeof query> }

export const startClaude = (host: Host, { resume, mode }: StartOptions): ClaudeProvider => {
  const { emit } = host
  const inbox = createInbox()
  let closed = false
  // Plans with a usage limit (Pro, Max, Team, Enterprise) don't charge per
  // token, so the SDK's dollar estimate only means something without one.
  let billedPerToken = false
  // Subagents: Agent tool calls in flight plus background tasks.
  const agentCalls = new Set<string>()
  const tasks = new Set<string>()
  const countAgents = () => emit({ type: 'agents', count: agentCalls.size + tasks.size })

  const canUseTool: CanUseTool = async (tool, input, { signal, suggestions, decisionReason }) => {
    if (tool === 'AskUserQuestion') {
      const answers = await host.ask((input.questions ?? []) as Question[], signal)
      return answers ? { behavior: 'allow', updatedInput: { ...input, answers } } : { behavior: 'deny', message: DECLINED }
    }
    const canAlways = !!suggestions?.length
    const choice = await host.approve(
      { tool: toolName(tool), detail: summarize(input), reason: decisionReason, diff: diffFor(tool, input), canAlways },
      signal,
    )
    if (choice === 'no') return { behavior: 'deny', message: DECLINED }
    if (choice === 'always' && canAlways) return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions }
    return { behavior: 'allow', updatedInput: input }
  }

  const q = query({
    prompt: inbox.messages,
    options: {
      cwd: process.cwd(),
      resume,
      permissionMode: mode,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: persona() },
      settingSources: ['user', 'project', 'local'],
      mcpServers: { codex: delegate.server() },
      canUseTool,
    },
  })

  // Also picks up a model changed with /model.
  const refreshContext = () =>
    q
      .getContextUsage()
      .then(usage => !closed && emit({ type: 'header', contextPct: Math.round(usage.percentage), model: modelName(usage.model) }))
      .catch(() => {})

  const refreshUsage = () =>
    q
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
      .then(usage => {
        if (closed) return
        const used = usage.rate_limits?.five_hour?.utilization
        if (used != null) emit({ type: 'header', usage: `${Math.round(used)}%` })
        else if (!usage.subscription_type) emit({ type: 'header', usage: `$${usage.session.total_cost_usd.toFixed(2)}` })
      })
      .catch(() => {})

  const refresh = () => {
    refreshContext()
    refreshUsage()
  }

  const handle = (msg: SDKMessage) => {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          emit({ type: 'session', id: msg.session_id })
          emit({ type: 'header', mode: msg.permissionMode, model: modelName(msg.model) })
          refresh()
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
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') emit({ type: 'text', text: event.delta.text })
        return
      }

      case 'assistant': {
        if (msg.parent_tool_use_id) return
        const reply = syntheticText(msg)
        if (reply) emit({ type: 'reply', text: reply })
        for (const block of msg.message.content) {
          if (block.type !== 'tool_use') continue
          const input = block.input as Record<string, unknown>
          if (block.name === 'Agent' || block.name === 'Task' || block.name === delegate.TOOL) {
            agentCalls.add(block.id)
            countAgents()
          }
          emit({
            type: 'tool',
            id: block.id,
            status: 'running',
            name: toolName(block.name),
            detail: summarize(input),
            diff: diffFor(block.name, input),
          })
        }
        return
      }

      case 'user': {
        if (msg.parent_tool_use_id || !Array.isArray(msg.message.content)) return
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue
          const text = typeof block.content === 'string' ? block.content : ''
          // A declined call is marked as failed, without the reason repeated under it.
          const failed = !!block.is_error
          emit({ type: 'tool', id: block.tool_use_id, status: failed ? 'error' : 'done', error: failed && text !== DECLINED ? text : undefined })
          if (agentCalls.delete(block.tool_use_id)) countAgents()
        }
        return
      }

      case 'result': {
        const cost = billedPerToken && msg.total_cost_usd ? ` · $${msg.total_cost_usd.toFixed(2)}` : ''
        emit({ type: 'end', failure: msg.subtype === 'success' ? undefined : msg.subtype.replaceAll('_', ' '), cost })
        return
      }
    }
  }

  q.supportedCommands()
    .then(commands => !closed && emit({ type: 'commands', names: commandNames(commands) }))
    .catch(() => {})
  q.accountInfo()
    .then(account => (billedPerToken = !account.subscriptionType))
    .catch(() => {})
  void (async () => {
    try {
      for await (const msg of q) if (!closed) handle(msg)
    } catch (err) {
      if (!closed) emit({ type: 'crash', message: err instanceof Error ? err.message : String(err) })
    }
  })()

  return {
    id: 'claude',
    label: 'Claude Code',
    query: q,
    send: prompt => inbox.send(prompt.content),
    interrupt: async () => void (await q.interrupt()),
    setMode: mode => q.setPermissionMode(mode),
    setModel: name => q.setModel(name),
    refresh,
    close: () => {
      closed = true
      delegate.stopAll()
      inbox.close()
      q.close()
    },
  }
}
