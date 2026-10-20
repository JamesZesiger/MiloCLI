// A tool Milo gives Claude: hand a task to a Codex agent running an OpenAI
// model, and get back what it said, ran and changed. Passing the thread id
// back keeps going with the same agent, so Claude can review its work and
// send it round again.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { relative } from 'node:path'
import { z } from 'zod'
import * as codex from './codex.js'
import { getState, setState } from './store.js'

/** The tool's name as Claude Code knows it: mcp__<server>__<tool>. */
export const TOOL = 'mcp__codex__agent'

const INSTRUCTIONS =
  'Another agent, Claude, handed you this task inside Milo, a terminal app. Do it, then finish with a short report for Claude: what you found or changed, and anything left undone.'

// Agents still working, so stopping or restarting Claude ends them too.
const running = new Set<AbortController>()

export const stopAll = () => {
  for (const agent of running) agent.abort()
  running.clear()
}

const describe = () => {
  const models = codex.codexModels().map(m => m.slug)
  return [
    "Hands a task to a Codex agent running one of OpenAI's models, on the user's ChatGPT plan. It works in the current folder with its own tools (shell, file edits) and reports back what it said, ran and changed.",
    'Use it when the user asks for a Codex or OpenAI agent, or wants a second model to take a task or a second look.',
    models.length ? `Models: ${models.join(', ')}. Leave model out for Codex's default.` : "Leave model out for Codex's default.",
    'It returns a thread_id: pass it back to continue with the same agent, for follow-ups or fixes.',
    'Set read_only for research or review. In Plan mode it is always read-only.',
  ].join(' ')
}

/** A fresh server for each Claude Code session: one can only be connected once. */
export const server = () =>
  createSdkMcpServer({
    name: 'codex',
    version: '1.0.0',
    tools: [
      tool(
        'agent',
        describe(),
        {
          prompt: z.string().describe('The task, with everything the agent needs to know: it sees none of this conversation.'),
          model: z.string().optional().describe('An OpenAI model, like gpt-6-astra.'),
          read_only: z.boolean().optional().describe('Look but change nothing.'),
          thread_id: z.string().optional().describe('Continue an earlier agent instead of starting a new one.'),
        },
        async ({ prompt, model, read_only, thread_id }, extra) => {
          const stop = new AbortController()
          ;(extra as { signal?: AbortSignal }).signal?.addEventListener('abort', () => stop.abort())
          running.add(stop)
          const mode = getState().mode
          let threadId = thread_id
          let reply = ''
          const commands: string[] = []
          const files = new Set<string>()
          const problems: string[] = []
          const end = await codex
            .run({
              threadId: thread_id,
              model,
              mode,
              sandbox: read_only || mode === 'plan' ? 'read-only' : undefined,
              instructions: INSTRUCTIONS,
              text: prompt,
              images: [],
              signal: stop.signal,
              onThread: id => (threadId = id),
              show: (item, done) => {
                if (item.type === 'command_execution' && !done && getState().busy)
                  setState({ status: `Codex: ${codex.commandText(item.command).slice(0, 60)}` })
                if (!done) return
                if (item.type === 'agent_message') reply = item.text
                else if (item.type === 'command_execution')
                  commands.push(`${codex.commandText(item.command)}${item.exit_code ? ` (exit ${item.exit_code})` : ''}`)
                else if (item.type === 'file_change') item.changes.forEach(change => files.add(relative(process.cwd(), change.path) || change.path))
                else if (item.type === 'error') problems.push(item.message)
              },
            })
            .finally(() => running.delete(stop))
          const used = threadId ? codex.status(threadId).model : undefined
          const report = [
            end.ok ? reply || '(The agent finished without saying anything.)' : end.stopped ? 'Stopped before it finished.' : `Failed: ${end.error}`,
            '',
            `Agent: ${used ?? model ?? "Codex's default model"}`,
            commands.length ? `Ran:\n${commands.map(c => `- ${c}`).join('\n')}` : 'Ran no commands.',
            files.size ? `Changed: ${[...files].join(', ')}` : 'Changed no files.',
            ...problems.map(p => `Problem: ${p}`),
            ...(threadId ? [`thread_id: ${threadId} (pass it back to continue with this agent)`] : []),
          ]
          return { content: [{ type: 'text', text: report.join('\n') }], isError: !end.ok }
        },
      ),
    ],
  })
