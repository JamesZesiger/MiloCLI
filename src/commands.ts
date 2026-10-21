// Claude Code commands that only work in its own interactive screen, rebuilt
// for Milo from the Agent SDK, plus helpers both front ends share.
import {
  getSessionMessages,
  listSessions,
  type AccountInfo,
  type AgentInfo,
  type SDKMessage,
  type SDKSessionInfo,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import stringWidth from 'string-width'
import { CHARACTER_NAMES, CHARACTERS, characterName, findCharacter, setCharacter } from './characters.js'
import { c, paint } from './milo.js'
import { describeSettings, saveSetting, SETTINGS_FILE } from './settings.js'
import { findTheme, setTheme, THEME_NAMES, THEMES, themeName } from './theme.js'
import type { Entry } from './store.js'

/**
 * /settings: lists Milo's settings, or saves one given as
 * `key value`, `key=value` or `key = "value"`. Returns what to show.
 */
export const settingsCommand = (args: string): { text: string; ok: boolean } => {
  const match = /^([\w-]+)\s*=?\s*(.*)$/.exec(args.trim())
  if (!match?.[1]) {
    const rows = describeSettings().map(
      s => `  ${c.focus(s.key)} = ${s.value ? `"${s.value}"` : c.dim('not set')}  ${c.dim(`· ${s.about}`)}`,
    )
    return { ok: true, text: [c.bold('Milo settings'), ...rows, c.dim(`/settings <name> <value> saves one to ${SETTINGS_FILE}`)].join('\n') }
  }
  const [, key, value = ''] = match
  if (!value) return { ok: false, text: `Give a value too, like /settings ${key} Auto` }
  const problem = saveSetting(key, value)
  return problem ? { ok: false, text: problem } : { ok: true, text: `Saved ${key} = "${value.replace(/^["']|["']$/g, '')}".` }
}

/**
 * /theme: lists the themes with a sample of each one's colors, or switches to
 * one and saves it for next time. Returns what to show.
 */
export const themeCommand = (args: string): { text: string; ok: boolean } => {
  const wanted = args.trim()
  if (!wanted) {
    const width = Math.max(...THEME_NAMES.map(name => name.length))
    const rows = THEME_NAMES.map(name => {
      const { about, colors } = THEMES[name]
      const sample = Object.values(colors).map(color => paint(color, '●')).join(' ')
      const mark = name === themeName() ? c.focus('❯') : ' '
      return ` ${mark} ${name.padEnd(width)}  ${sample}  ${c.dim(about)}`
    })
    return { ok: true, text: [c.bold('Themes'), ...rows, c.dim('/theme <name> switches; Milo remembers it.')].join('\n') }
  }
  const name = findTheme(wanted)
  if (!name) return { ok: false, text: `Unknown theme ${wanted}. Choose from: ${THEME_NAMES.join(', ')}` }
  setTheme(name)
  const problem = saveSetting('theme', name)
  return problem ? { ok: false, text: `Switched to ${name}, but ${problem}` } : { ok: true, text: `Switched to the ${name} theme.` }
}

/**
 * /char: lists the mascots, or switches to one and saves it for next time.
 * `changed` says whether Claude Code needs restarting for the new personality.
 */
export const characterCommand = (args: string): { text: string; ok: boolean; changed?: boolean } => {
  const wanted = args.trim()
  if (!wanted) {
    const width = Math.max(...CHARACTER_NAMES.map(name => name.length))
    const faceWidth = Math.max(...CHARACTER_NAMES.map(name => stringWidth(CHARACTERS[name].faces.idle)))
    const rows = CHARACTER_NAMES.map(name => {
      const mark = name === characterName() ? c.focus('❯') : ' '
      const face = CHARACTERS[name].faces.idle
      return ` ${mark} ${name.padEnd(width)}  ${face}${' '.repeat(faceWidth - stringWidth(face))}  ${c.dim(CHARACTERS[name].about)}`
    })
    return { ok: true, text: [c.bold('Characters'), ...rows, c.dim('/char <name> switches; Milo remembers it.')].join('\n') }
  }
  const name = findCharacter(wanted)
  if (!name) return { ok: false, text: `Unknown character ${wanted}. Choose from: ${CHARACTER_NAMES.join(', ')}` }
  if (name === characterName()) return { ok: true, text: `${CHARACTERS[name].name} is already here.` }
  setCharacter(name)
  const problem = saveSetting('character', name)
  const hello = name === 'none' ? 'No mascot: Claude speaks for itself.' : `${CHARACTERS[name].name} is here.`
  return problem ? { ok: false, text: `Switched to ${name}, but ${problem}`, changed: true } : { ok: true, text: hello, changed: true }
}

/** Built-in commands like /context and /model reply with one unstreamed message. */
export const syntheticText = (msg: SDKMessage): string | undefined => {
  if (msg.type !== 'assistant' || msg.parent_tool_use_id || msg.message.model !== '<synthetic>') return undefined
  const text = msg.message.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
  return text || undefined
}

export const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60000)
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 60 / 24)}d ago`
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** This folder's most recent conversations, newest first. */
export const recentSessions = (limit = 10) => listSessions({ dir: process.cwd(), limit })

/** The most recent conversations in every folder, newest first. */
export const allSessions = (limit = 30) => listSessions({ limit })

export const formatSessions = (sessions: SDKSessionInfo[]) =>
  sessions.length
    ? [
        c.bold('Recent conversations in this folder'),
        ...sessions.map(
          (s, i) =>
            `  ${c.focus(String(i + 1).padStart(2))}. ${clip(s.customTitle || s.summary || s.firstPrompt || '(untitled)', 60)} ${c.dim(`· ${ago(s.lastModified)}`)}`,
        ),
        c.dim('/resume <number> picks one'),
      ].join('\n')
    : 'No earlier conversations in this folder.'

/** Picks a session by its number in the last list, or by id. */
export const pickSession = (arg: string, listed: SDKSessionInfo[]) => {
  const n = Number(arg)
  if (Number.isInteger(n) && n >= 1) return listed[n - 1]?.sessionId
  return /^[0-9a-f-]{36}$/i.test(arg) ? arg : undefined
}

type Block = { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }

/** A saved conversation as log entries: what was said and which tools ran. */
export const history = async (sessionId: string, summarize: (input: Record<string, unknown>) => string, dir = process.cwd()) => {
  const entries: Entry[] = []
  for (const msg of await getSessionMessages(sessionId, { dir })) {
    if (msg.parent_tool_use_id) continue
    const { content } = (msg.message ?? {}) as { content?: string | Block[] }
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
    for (const block of blocks) {
      // Command markup and reminders are tagged; what people typed is not.
      if (block.type === 'text' && block.text?.trim() && !block.text.trimStart().startsWith('<'))
        entries.push({ kind: msg.type === 'user' ? 'user' : 'assistant', text: block.text })
      else if (block.type === 'tool_use' && msg.type === 'assistant')
        entries.push({ kind: 'tool', id: block.id ?? '', name: block.name ?? '', detail: summarize(block.input ?? {}), status: 'done' })
    }
  }
  return entries
}

export const formatCommands = (commands: SlashCommand[]) => {
  const line = (cmd: SlashCommand) => {
    const name = `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`
    return `  ${c.focus(name)} ${c.dim(clip(cmd.description, 70))}`
  }
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name))
  return [
    c.bold('Claude Code commands'),
    ...sorted.filter(cmd => cmd.builtin && !cmd.name.startsWith('__')).map(line),
    c.bold('Skills and custom commands'),
    ...sorted.filter(cmd => !cmd.builtin).map(line),
  ].join('\n')
}

/** Claude Code's command names worth suggesting: built-ins first, then skills. */
export const commandNames = (commands: SlashCommand[]) =>
  [...commands]
    .filter(cmd => !cmd.name.startsWith('__'))
    .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name))
    .map(cmd => cmd.name)

/**
 * What would finish the command being typed: the rest of a command name (with
 * a space after it), or of its first option. Empty when nothing fits.
 */
export const completion = (input: string, names: string[], options: Record<string, readonly string[]> = {}) => {
  const name = /^\/(\S*)$/.exec(input)?.[1]
  if (name !== undefined) {
    const typed = name.toLowerCase()
    if (names.some(n => n.toLowerCase() === typed)) return ''
    const found = names.find(n => n.toLowerCase().startsWith(typed))
    return found ? `${found.slice(typed.length)} ` : ''
  }
  const [, cmd = '', word = ''] = /^\/(\S+) +(\S*)$/.exec(input) ?? []
  const typed = word.toLowerCase()
  const found = options[cmd.toLowerCase()]?.find(o => o.toLowerCase().startsWith(typed) && o.length > typed.length)
  return found ? found.slice(typed.length) : ''
}

export const formatAgents =(agents: AgentInfo[]) =>
  agents.length
    ? [
        c.bold('Subagents'),
        ...agents.map(a => `  ${c.focus(a.name)}${a.model ? c.dim(` (${a.model})`) : ''} ${c.dim(clip(a.description, 70))}`),
        c.dim('Add your own in .claude/agents or ~/.claude/agents.'),
      ].join('\n')
    : 'No subagents available.'

export const formatStatus = (info: {
  account?: AccountInfo
  model: string
  mode: string
  sessionId?: string
  contextPct?: number
}) =>
  [
    c.bold('Status'),
    `  Folder      ${process.cwd()}`,
    `  Session     ${info.sessionId ?? c.dim('starting…')}`,
    `  Model       ${info.model || c.dim('starting…')}`,
    `  Mode        ${info.mode}`,
    `  Context     ${info.contextPct === undefined ? '–' : `${info.contextPct}%`}`,
    ...(info.account?.organization ? [`  Org         ${info.account.organization}`] : []),
    ...(info.account?.subscriptionType ? [`  Plan        ${info.account.subscriptionType}`] : []),
    ...(info.account?.apiProvider ? [`  Provider    ${info.account.apiProvider}`] : []),
  ].join('\n')
