// Codex as a provider: OpenAI models on the user's ChatGPT plan, one Codex
// turn per prompt on a thread. Codex can't ask before each action, so the
// permission mode picks its sandbox instead (see codex.ts).
import type { ThreadItem } from '@openai/codex-sdk'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import * as codex from '../codex.js'
import type { Diff } from '../store.js'
import { clip, type Host, type Provider, type StartOptions } from '../provider.js'

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

/** "codex" is Codex's own default model. */
const slug = (name: string | undefined) => (!name || name.toLowerCase() === 'codex' ? undefined : name)

export const startCodex = ({ emit }: Host, options: StartOptions): Provider => {
  let threadId = options.resume
  let model = slug(options.model)
  let mode: string = options.mode ?? 'default'
  let turn: AbortController | undefined
  // Tool calls still running, marked failed if the turn ends first.
  const running = new Set<string>()

  const tool = (id: string, status: 'running' | 'done' | 'error', name: string, detail: string, error?: string, diff?: Diff) => {
    if (status === 'running') running.add(id)
    else running.delete(id)
    emit({ type: 'tool', id, status, name, detail, error, diff })
  }

  /** Puts what Codex is doing in the log, as if Claude were doing it. */
  const show = (item: ThreadItem, done: boolean) => {
    switch (item.type) {
      case 'agent_message':
        if (done && item.text) emit({ type: 'reply', text: item.text })
        return
      case 'command_execution': {
        const failed = item.status === 'failed' || (item.exit_code ?? 0) !== 0
        const output = item.aggregated_output.trim().split('\n').slice(-5).join('\n')
        tool(item.id, !done ? 'running' : failed ? 'error' : 'done', 'Bash', clip(codex.commandText(item.command)), failed && done ? output : undefined)
        return
      }
      case 'file_change': {
        const files = item.changes.map(change => relative(process.cwd(), change.path) || change.path)
        const updated = item.changes.find(change => change.kind !== 'delete')
        tool(item.id, item.status === 'failed' ? 'error' : 'done', 'Edit', clip(files.join(', ')), undefined, updated && diffSinceCommit(updated.path))
        return
      }
      case 'mcp_tool_call':
        tool(item.id, !done ? 'running' : item.status === 'failed' ? 'error' : 'done', `${item.server}.${item.tool}`, '', item.error?.message)
        return
      case 'web_search':
        tool(item.id, done ? 'done' : 'running', 'WebSearch', clip(item.query))
        return
      case 'error':
        emit({ type: 'note', text: item.message, tone: 'error' })
        return
    }
  }

  const refresh = () => {
    if (!threadId) return
    const found = codex.status(threadId)
    emit({ type: 'header', model: found.model, contextPct: found.contextPct, usage: found.usage })
  }

  const showModel = () => emit({ type: 'header', model: model ? codex.modelName(model) : 'Codex' })

  showModel()
  emit({ type: 'commands', names: [] })
  if (threadId) {
    emit({ type: 'session', id: threadId })
    refresh()
  }

  return {
    id: 'codex',
    label: 'Codex',
    send: prompt => {
      const current = new AbortController()
      turn = current
      void codex
        .run({
          threadId,
          model,
          mode,
          text: prompt.text,
          images: prompt.images,
          signal: current.signal,
          onThread: id => {
            if (current !== turn) return
            threadId = id
            emit({ type: 'session', id })
          },
          show: (item, done) => current === turn && show(item, done),
        })
        .then(end => {
          if (current !== turn) return
          turn = undefined
          for (const id of running) emit({ type: 'tool', id, status: 'error' })
          running.clear()
          if (!end.ok && end.error) emit({ type: 'note', text: `Codex: ${end.error}`, tone: 'error' })
          emit({ type: 'end', failure: end.ok ? undefined : end.stopped ? 'interrupted' : 'error' })
        })
    },
    // With no turn running there's nothing to stop; Milo's stop timer takes over.
    interrupt: async () => turn?.abort(),
    // Codex picks its sandbox from the mode at the start of each turn.
    setMode: async next => {
      mode = next
    },
    setModel: async name => {
      model = slug(name)
      showModel()
    },
    refresh,
    close: () => {
      turn?.abort()
      turn = undefined
    },
  }
}
