// Milo in plain line mode: used when input or output is not a terminal, or
// with --plain. Claude Code runs in the background through the Agent SDK.
import { query, type CanUseTool, type SDKMessage, type SDKSessionInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { c, face, small, pick, VERBS, PAST, PERSONA, type Mood } from './milo.js'
import { portrait, width, type Size } from './portrait.js'
import {
  commandNames,
  completion,
  formatAgents,
  formatCommands,
  formatSessions,
  pickSession,
  recentSessions,
  settingsCommand,
  syntheticText,
} from './commands.js'
import { withImages, type Content } from './images.js'
import { settings, settingsProblems, SETTING_NAMES, SETTINGS_FILE } from './settings.js'

const isTTY = stdout.isTTY === true

// --- Input queue: one long-lived session, fed a message per prompt ---------

const pending: SDKUserMessage[] = []
let wake: (() => void) | undefined
let inputClosed = false

async function* inbox(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    while (pending.length) yield pending.shift()!
    if (inputClosed) return
    await new Promise<void>(resolve => (wake = resolve))
  }
}

const send = (content: Content) => {
  pending.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })
  wake?.()
}

// --- Spinner ---------------------------------------------------------------

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽']
let spinner: NodeJS.Timeout | undefined

const stopSpinner = () => {
  if (!spinner) return
  clearInterval(spinner)
  spinner = undefined
  stdout.write('\r\x1b[2K')
}

const startSpinner = (mood: Mood) => {
  stopSpinner()
  if (!isTTY) return
  const verb = pick(VERBS)
  let i = 0
  spinner = setInterval(() => {
    stdout.write(`\r\x1b[2K${c.orange(FRAMES[i++ % FRAMES.length]!)} ${small(mood)} ${c.dim(`${verb}…`)}`)
  }, 120)
}

// --- Drawing ---------------------------------------------------------------

let atLineStart = true
let replyStarted = false

const write = (text: string) => {
  stdout.write(text)
  if (text.length) atLineStart = text.endsWith('\n')
}
const line = (text = '') => write((atLineStart ? '' : '\n') + text + '\n')

// The color portrait needs color and room; otherwise the small ASCII face.
const canDrawPortrait = (size: Size = 'tiny') =>
  isTTY && !process.env.NO_COLOR && (stdout.columns ?? 0) >= width(size) + 4

const drawFace = (mood: Mood, info: string[] = [], size: Size = 'tiny') => {
  const art = canDrawPortrait(size) ? portrait(mood, size) : face(mood).map(row => c.orange(row.padEnd(13)))
  const offset = Math.max(0, Math.floor((art.length - info.length) / 2))
  line()
  art.forEach((row, i) => line(`${row}  ${info[i - offset] ?? ''}`))
  line()
}

const banner = () => {
  const info = [
    c.bold(c.orange('Milo')),
    c.dim('your coding cat, powered by Claude Code'),
    c.dim(process.cwd()),
    '',
    c.dim('/help for commands · Ctrl+C stops a reply'),
  ]
  // Beside the portrait only when both fit on one line.
  if (canDrawPortrait() && (stdout.columns ?? 0) < width() + 50) {
    drawFace('idle')
    info.forEach(row => line(row))
    line()
  } else drawFace('idle', info)
}

const HELP = `${c.bold('Commands')}
  /help         show this
  /commands     list every Claude Code command and skill you can use
  /resume [n]   list recent conversations here, or pick one up
  /continue     pick up the most recent conversation here
  /agents       list the subagents Claude can use
  /milo         show Milo (add small or big, and thinking, working or error)
  /settings     show Milo's settings, or save one: /settings default_mode Auto
  /new          start a fresh conversation
  /exit         leave (Ctrl+D works too)
  Tab finishes the command you are typing.
  Image files named in a prompt (typed or dragged in) are sent as pictures.
  Anything else, including Claude Code commands like /model, /context, /compact and /usage, goes to Claude.
  Milo's own settings, like default_mode = "Auto", live in ${SETTINGS_FILE}.`

// Milo's own commands, suggested ahead of Claude Code's, and their options.
const MILO_COMMANDS = ['help', 'commands', 'resume', 'continue', 'agents', 'milo', 'settings', 'new', 'exit']
const OPTIONS = { milo: ['small', 'big', 'thinking', 'working', 'error'], settings: SETTING_NAMES }
let commandList = MILO_COMMANDS

// Tab finishes the command being typed.
const completer = (typed: string): [string[], string] => {
  const rest = completion(typed, commandList, OPTIONS)
  return [rest ? [typed + rest] : [], typed]
}

const clip = (text: string, max = 90) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const summarize = (tool: string, input: Record<string, unknown>): string => {
  const key = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'].find(
    k => typeof input[k] === 'string',
  )
  return key ? clip(String(input[key])) : ''
}

// --- Permissions: Claude asks, Milo asks you -------------------------------

let rl: readline.Interface

const askUser = async (question: string): Promise<string> => {
  stopSpinner()
  const answer = (await rl.question(question)).trim()
  return answer
}

const answerQuestions = async (input: Record<string, unknown>) => {
  const questions = (input.questions ?? []) as {
    question: string
    options: { label: string; description: string }[]
    multiSelect: boolean
  }[]
  const answers: Record<string, string> = {}
  for (const q of questions) {
    line(`${c.orange(small('thinking'))} ${c.bold(q.question)}`)
    q.options.forEach((o, i) => line(`  ${c.cyan(String(i + 1))}. ${o.label} ${c.dim(`- ${o.description}`)}`))
    const hint = q.multiSelect ? 'numbers separated by commas, or type your own' : 'a number, or type your own'
    const raw = await askUser(c.dim(`  (${hint}) `) + c.orange('❯ '))
    const picked = raw
      .split(',')
      .map(s => q.options[Number(s.trim()) - 1]?.label)
      .filter((l): l is string => !!l)
    answers[q.question] = picked.length ? picked.join(', ') : raw
  }
  return answers
}

const canUseTool: CanUseTool = async (tool, input, { suggestions, decisionReason }) => {
  if (tool === 'AskUserQuestion') {
    const answers = await answerQuestions(input)
    startSpinner('thinking')
    return { behavior: 'allow', updatedInput: { ...input, answers } }
  }

  line(`${c.orange(small('working'))} ${c.bold('Milo wants to use')} ${c.cyan(tool)}`)
  const detail = summarize(tool, input)
  if (detail) line(`  ${detail}`)
  if (decisionReason) line(c.dim(`  ${clip(decisionReason)}`))

  const choices = suggestions?.length ? '[y]es / [n]o / [a]lways ' : '[y]es / [n]o '
  const answer = (await askUser(`  Allow? ${choices}`)).toLowerCase()
  startSpinner('working')

  if (answer === 'a' && suggestions?.length) return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions }
  if (answer === 'y' || answer === 'yes' || answer === 'a') return { behavior: 'allow', updatedInput: input }
  line(c.dim('  Declined.'))
  return { behavior: 'deny', message: DECLINED }
}

const DECLINED = 'The user declined this action.'

// --- One background session ------------------------------------------------

let session: ReturnType<typeof query>
let sessionId: string | undefined
let listed: SDKSessionInfo[] = []
let turnDone: (() => void) | undefined
let turnStarted = 0

const endTurn = () => {
  stopSpinner()
  const done = turnDone
  turnDone = undefined
  done?.()
}

const handle = (msg: SDKMessage) => {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') sessionId = msg.session_id
      return

    case 'stream_event': {
      if (msg.parent_tool_use_id) return
      const event = msg.event
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        stopSpinner()
        if (!replyStarted) {
          replyStarted = true
          line()
          line(`${c.orange(small('idle'))} ${c.bold(c.orange('Milo'))}`)
        }
        write(event.delta.text)
      }
      return
    }

    case 'assistant': {
      if (msg.parent_tool_use_id) return
      const reply = syntheticText(msg)
      if (reply) {
        stopSpinner()
        line()
        line(`${c.orange(small('idle'))} ${c.bold(c.orange('Milo'))}`)
        line(reply)
      }
      for (const block of msg.message.content) {
        if (block.type !== 'tool_use') continue
        stopSpinner()
        const detail = summarize(block.name, block.input as Record<string, unknown>)
        line(c.dim(`  ↳ ${block.name}${detail ? `  ${detail}` : ''}`))
        replyStarted = false
        startSpinner('working')
      }
      return
    }

    case 'user': {
      if (msg.parent_tool_use_id || !Array.isArray(msg.message.content)) return
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && block.is_error) {
          const text = typeof block.content === 'string' ? block.content : 'the tool reported an error'
          if (text === DECLINED) continue // already shown at the prompt
          stopSpinner()
          line(c.red(`  ${small('error')} ${clip(text)}`))
          startSpinner('thinking')
        }
      }
      return
    }

    case 'result': {
      stopSpinner()
      const seconds = Math.max(1, Math.round((Date.now() - turnStarted) / 1000))
      const cost = billedPerToken && msg.total_cost_usd ? ` · session $${msg.total_cost_usd.toFixed(2)}` : ''
      line()
      if (msg.subtype === 'success') line(c.dim(`${small('idle')} Milo ${pick(PAST)} · ${seconds}s${cost}`))
      else line(c.red(`${small('error')} Milo stopped (${msg.subtype.replaceAll('_', ' ')})`))
      line()
      endTurn()
      return
    }
  }
}

// Plans with a usage limit don't charge per token, so only show the SDK's
// dollar estimate without a subscription.
let billedPerToken = false

const startSession = (resume?: string) => {
  inputClosed = false
  session = query({
    prompt: inbox(),
    options: {
      cwd: process.cwd(),
      resume,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PERSONA },
      settingSources: ['user', 'project', 'local'],
      canUseTool,
    },
  })
  const current = session
  if (settings.defaultMode)
    current.setPermissionMode(settings.defaultMode).catch(() => line(c.red(`${settings.defaultMode} mode isn't available here.`)))
  current
    .supportedCommands()
    .then(commands => (commandList = [...new Set([...MILO_COMMANDS, ...commandNames(commands)])]))
    .catch(() => {})
  current
    .accountInfo()
    .then(account => (billedPerToken = !account.subscriptionType))
    .catch(() => {})
  void (async () => {
    try {
      for await (const msg of current) handle(msg)
    } catch (err) {
      if (current !== session) return
      stopSpinner()
      line(c.red(`${small('error')} Claude Code stopped: ${err instanceof Error ? err.message : String(err)}`))
      endTurn()
    }
  })()
}

const resumeSession = (id: string | undefined) => {
  if (!id) {
    line(c.dim('Pick a number from /resume, or give a session id.'))
    return
  }
  closeSession()
  sessionId = undefined
  startSession(id)
  line(c.dim(`${small('idle')} Resumed ${id}.`))
}

const closeSession = () => {
  inputClosed = true
  pending.length = 0
  wake?.()
  session.close()
}

// --- Main loop -------------------------------------------------------------

const main = async () => {
  rl = readline.createInterface({ input: stdin, output: stdout, terminal: isTTY, completer })
  // The first Ctrl+C in a turn stops the reply; a second one, if it hasn't
  // stopped, leaves.
  let stopping: (() => void) | undefined
  rl.on('SIGINT', () => {
    if (turnDone && stopping !== turnDone) {
      stopping = turnDone
      stopSpinner()
      line(c.dim('  Stopping… (Ctrl+C again to leave)'))
      session.interrupt().catch(() => {})
    } else {
      line()
      shutdown()
    }
  })
  rl.on('close', shutdown) // Ctrl+D or end of piped input

  banner()
  for (const problem of settingsProblems) line(c.red(problem))
  startSession()

  while (true) {
    let text: string
    try {
      text = (await rl.question(c.orange('❯ '))).trim()
    } catch {
      break // input closed (Ctrl+D)
    }
    if (!text) continue
    if (text === '/exit' || text === '/quit') break
    if (text === '/help') {
      line(HELP)
      line()
      continue
    }
    if (text === '/milo' || text.startsWith('/milo ')) {
      const args = text.slice(5).trim().split(/\s+/)
      const mood = (['thinking', 'working', 'error'] as const).find(m => args.includes(m)) ?? 'idle'
      const size = (['small', 'big'] as const).find(s => args.includes(s)) ?? 'tiny'
      drawFace(mood, [], size)
      continue
    }
    const [name, arg] = text.split(/\s+/)
    if (name === '/settings') {
      const result = settingsCommand(text.slice(name.length))
      line(result.ok ? result.text : c.red(result.text))
      if (result.ok && arg) line(c.dim('It takes effect the next time Milo starts.'))
      line()
      continue
    }
    try {
      if (name === '/commands') {
        line(formatCommands(await session.supportedCommands()))
        line()
        continue
      }
      if (name === '/agents') {
        line(formatAgents(await session.supportedAgents()))
        line()
        continue
      }
      if (name === '/resume') {
        if (arg) resumeSession(pickSession(arg, listed))
        else {
          listed = (await recentSessions()).filter(f => f.sessionId !== sessionId)
          line(formatSessions(listed))
        }
        line()
        continue
      }
      if (name === '/continue') {
        const last = (await recentSessions(2)).find(f => f.sessionId !== sessionId)
        if (last) resumeSession(last.sessionId)
        else line(c.dim('No earlier conversations in this folder.'))
        line()
        continue
      }
    } catch (err) {
      line(c.red(`${small('error')} ${err instanceof Error ? err.message : String(err)}`))
      continue
    }
    if (text === '/new') {
      closeSession()
      sessionId = undefined
      startSession()
      line(c.dim(`${small('idle')} Fresh start.`))
      line()
      continue
    }

    const prompt = withImages(text)
    for (const image of prompt.images) line(c.dim(`  🖼  ${image}`))
    for (const problem of prompt.problems) line(c.red(`  ${problem}`))
    replyStarted = false
    turnStarted = Date.now()
    const finished = new Promise<void>(resolve => (turnDone = resolve))
    startSpinner('thinking')
    send(prompt.content)
    await finished
  }
  shutdown()
}

let shuttingDown = false

const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  stopSpinner()
  closeSession()
  rl.close()
  if (sessionId) line(c.dim(`Session ${sessionId}. Resume it in Claude Code with: claude --resume ${sessionId}`))
  line(c.dim(`${small('idle')} Bye!`))
  process.exit(0)
}

void main()
