// Milo's full-screen layout: a fixed header, a scrolling workspace (or a
// side-by-side diff), a status line and the input box.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, usePaste, useStdin, useStdout, useWindowSize } from 'ink'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import { relative } from 'node:path'
import { c, type Mood } from './milo.js'
import { portrait, type Size } from './portrait.js'
import { align } from './diff.js'
import { logLines } from './render.js'
import { highlight, isEmpty, selectedText, type Selection } from './select.js'
import { completion, formatAgents, formatCommands, formatSessions, formatStatus, pickSession, recentSessions } from './commands.js'
import { getState, push, setState, useStore, type Diff, type State } from './store.js'
import * as session from './session.js'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'

const HEADER_HEIGHT = 8
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽']

const FACES: Record<Mood, string> = {
  idle: '|ᐠ｡ꞈ｡ᐟ|',
  thinking: '|ᐠ-ꞈ-ᐟ|',
  working: '|ᐠ•ꞈ•ᐟ|',
  error: '|ᐠ×ꞈ×ᐟ|',
}

const MODE_LABELS: Record<string, string> = {
  default: 'Default mode',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  auto: 'Auto mode',
  bypassPermissions: 'Bypass permissions',
  dontAsk: "Don't ask",
}

const HELP = [
  c.bold('Commands'),
  '  /help          show this',
  '  /commands      list every Claude Code command and skill you can use',
  '  /resume [n]    list recent conversations here, or pick one up',
  '  /continue      pick up the most recent conversation here',
  '  /status        show the session, model, mode and account',
  '  /mode [name]   show or switch permission mode',
  '  /agents        list the subagents Claude can use',
  '  /milo [size]   show Milo (small or big; thinking, working or error)',
  '  /diff          show or hide the last file change',
  '  /copy [n]      copy the last reply, or the nth from last, to the clipboard',
  '  /new           start a fresh conversation',
  '  /exit          leave',
  c.bold('Keys'),
  '  Tab            finish the command you are typing',
  '  PgUp / PgDn    scroll the workspace or the diff (the mouse wheel works too)',
  '  Ctrl+O         show or hide the last file change',
  '  Drag           select text in the workspace; letting go copies it',
  '  Shift+Tab      switch permission mode',
  '  Esc            stop a reply, or close the diff',
  '  Ctrl+C         stop a reply (twice forces it), clear the input, or leave',
  'Anything else, including Claude Code commands like /model, /context, /compact and /usage, goes to Claude.',
].join('\n')

// Milo's own commands, suggested ahead of Claude Code's, and their options.
const MILO_COMMANDS = ['help', 'commands', 'resume', 'continue', 'status', 'mode', 'agents', 'milo', 'diff', 'copy', 'new', 'exit']
const OPTIONS: Record<string, readonly string[]> = {
  mode: session.MODES,
  milo: ['small', 'big', 'thinking', 'working', 'error'],
}

const seconds = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const shortPath = (path: string, max: number) =>
  path.length > max ? `…${path.slice(path.length - max + 1)}` : path

// --- Mouse -----------------------------------------------------------------

// Button-event mouse reporting (1002) in SGR encoding (1006): each press,
// drag and release arrives as ESC [ < button ; x ; y M (m for a release),
// with 1-based x and y. Button 64 and 65 are the wheel; 32 marks a drag.
const MOUSE_ON = '\x1b[?1002h\x1b[?1006h'
const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l'
const MOUSE_REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
const WHEEL_LINES = 3

type Mouse =
  | { kind: 'wheel'; direction: -1 | 1 }
  | { kind: 'press' | 'drag' | 'release'; x: number; y: number }

// Ink drops mouse reports before they reach useInput, so peek at what it
// reads from stdin and pass the wheel and the left button on.
const useMouse = (onMouse: (event: Mouse) => void) => {
  const { stdin } = useStdin()
  const { stdout } = useStdout()
  const handler = useRef(onMouse)
  handler.current = onMouse
  useEffect(() => {
    const stream = stdin as NodeJS.ReadStream
    const read = stream.read
    stream.read = ((size?: number) => {
      const chunk = read.call(stream, size)
      if (chunk !== null)
        for (const [, button, x, y, end] of String(chunk).matchAll(MOUSE_REPORT)) {
          // Ignore the Shift/Meta/Ctrl bits; 66 and 67 are sideways scrolls.
          const b = Number(button) & ~(4 | 8 | 16)
          const at = { x: Number(x), y: Number(y) }
          if (b === 64 || b === 65) handler.current({ kind: 'wheel', direction: b === 64 ? -1 : 1 })
          else if ((b & 3) !== 0) continue // only the left button selects
          else if (end === 'm') handler.current({ kind: 'release', ...at })
          else handler.current({ kind: b & 32 ? 'drag' : 'press', ...at })
        }
      return chunk
    }) as typeof read
    stdout.write(MOUSE_ON)
    return () => {
      stream.read = read
      stdout.write(MOUSE_OFF)
    }
  }, [stdin, stdout])
}

/** Puts text on the clipboard with OSC 52, which works over SSH and WSL too. */
const copyToClipboard = (stdout: NodeJS.WritableStream, text: string) =>
  stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`)

// --- Header ----------------------------------------------------------------

const Header = ({ width, s }: { width: number; s: State }) => {
  const showArt = width >= 50
  const showRight = width >= 64
  const pct = s.contextPct === undefined ? '–' : `${s.contextPct}%`
  const agents = `${s.agents} agent${s.agents === 1 ? '' : 's'} · ${s.busy ? 'working' : 'idle'}`
  const info = [
    c.bold(c.orange('Milo')),
    'your coding cat, powered by Claude Code',
    c.dim(shortPath(process.cwd(), Math.max(16, width - 50))),
    '',
    c.dim('/help for commands · Ctrl+C stops a reply'),
  ]
  const right = [s.model || c.dim('starting…'), `🧠 ${pct} context`, MODE_LABELS[s.mode] ?? s.mode, agents]
  return (
    <Box borderStyle="round" height={HEADER_HEIGHT} width={width} paddingX={1}>
      {showArt && (
        <Box flexDirection="column" marginRight={2} flexShrink={0}>
          {portrait(s.mood).map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {info.map((line, i) => (
          <Text key={i} wrap="truncate">
            {line || ' '}
          </Text>
        ))}
      </Box>
      {showRight && (
        <Box flexDirection="column" alignItems="flex-end" flexShrink={0} marginLeft={2}>
          {right.map((line, i) => (
            <Text key={i} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

// --- Workspace: the message log --------------------------------------------

// The workspace's box: a round border plus one column of padding each side,
// inside the app's own one column of padding.
const WORKSPACE_TOP = HEADER_HEIGHT + 2 // screen row (1-based) of its first line
const WORKSPACE_LEFT = 4 // screen column (1-based) of its first character

const Workspace = ({
  width,
  height,
  lines,
  first,
  offset,
  selection,
}: {
  width: number
  height: number
  lines: string[]
  first: number
  offset: number
  selection: Selection | undefined
}) => {
  const innerHeight = Math.max(1, height - 2)
  let view: string[]
  if (!lines.length) {
    view = [
      c.dim('Ask Milo anything.'),
      c.dim('PgUp/PgDn scrolls · drag to select and copy · Ctrl+O shows the last file change · Shift+Tab switches mode'),
    ]
  } else {
    view = lines.slice(first, first + innerHeight).map((line, i) => highlight(line, first + i, selection))
    if (offset > 0) view[view.length - 1] = c.dim(`── ${offset} more line${offset === 1 ? '' : 's'} below · PgDn ──`)
  }
  return (
    <Box borderStyle="round" width={width} height={height} flexDirection="column" paddingX={1} overflow="hidden">
      {view.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line || ' '}
        </Text>
      ))}
    </Box>
  )
}

// --- Diff: old and new side by side ----------------------------------------

const DiffView = ({ width, height, diff, scroll }: { width: number; height: number; diff: Diff; scroll: number }) => {
  const rows = useMemo(() => align(diff.before, diff.after), [diff])
  const gap = 2
  const paneWidth = Math.floor((width - gap) / 2)
  const bodyHeight = Math.max(1, height - 3)
  const lineNo = (n: number) => n + diff.start - 1
  const numWidth = String(lineNo(rows.reduce((n, r) => Math.max(n, r.left?.n ?? 0, r.right?.n ?? 0), 0))).length
  const textWidth = Math.max(4, paneWidth - 4 - numWidth - 1)
  const top = Math.min(scroll, Math.max(0, rows.length - bodyHeight))
  const visible = rows.slice(top, top + bodyHeight)
  const file = relative(process.cwd(), diff.file) || diff.file

  const cell = (side: { n: number; text: string } | undefined, paint: (s: string) => string, changed: boolean) => {
    if (!side) return ' '
    const text = side.text.replaceAll('\t', '  ')
    const shown = text.length > textWidth ? `${text.slice(0, textWidth - 1)}…` : text
    return `${c.dim(String(lineNo(side.n)).padStart(numWidth))} ${changed ? paint(shown) : shown}`
  }

  const pane = (title: string, side: 'left' | 'right') => (
    <Box borderStyle="round" width={paneWidth} height={height} flexDirection="column" paddingX={1} overflow="hidden">
      <Text wrap="truncate">{title}</Text>
      {visible.map((row, i) => (
        <Text key={i} wrap="truncate">
          {side === 'left'
            ? cell(row.left, c.red, row.kind === 'del' || row.kind === 'change')
            : cell(row.right, c.green, row.kind === 'add' || row.kind === 'change')}
        </Text>
      ))}
    </Box>
  )

  const more = rows.length > bodyHeight ? c.dim(` · ${top + 1}–${top + visible.length} of ${rows.length}`) : ''
  return (
    <Box width={width} height={height}>
      {pane(`${c.red('old')} ${c.dim(shortPath(file, paneWidth - 12))}`, 'left')}
      <Box width={gap} />
      {pane(`${c.green('new')}${more}`, 'right')}
    </Box>
  )
}

// --- Status line and input box ---------------------------------------------

const StatusLine = ({ width, s, frame, now, notice }: { width: number; s: State; frame: number; now: number; notice: string }) => {
  const time = seconds(s.busy ? now - s.turnStarted : s.lastTurnMs)
  const tools = `${s.turnTools} tool${s.turnTools === 1 ? '' : 's'}${s.currentTool ? ` · ${s.currentTool}` : ''}`
  const message = notice
    ? c.green(notice)
    : s.busy
      ? `${c.orange(FRAMES[frame % FRAMES.length]!)} ${s.status}…`
      : s.status
  return (
    <Box width={width} height={1}>
      <Text wrap="truncate">
        {` ${c.orange(FACES[s.mood])} ${message}  ${c.dim(time)}  ${c.dim(tools)}`}
      </Text>
    </Box>
  )
}

/** The input box's lines: a permission prompt, a question, or what you type. */
const inputLines = (s: State, input: string, cursor: number, width: number, ghost: string): string[] => {
  const inner = width - 2
  // Wrapped lines keep one space between them and the border.
  const fit = (text: string) =>
    wrapAnsi(text, Math.max(10, inner - 1), { hard: true, trim: false })
      .split('\n')
      .map((line, i) => (i === 0 ? line : ` ${line}`))
  const asking = s.pending
  if (asking?.kind === 'permission') {
    const detail = asking.detail ? ` ${c.dim(asking.detail)}` : ''
    const keys = `${c.bold('[y]')}es  ${c.bold('[n]')}o${asking.canAlways ? `  ${c.bold('[a]')}lways` : ''}`
    const diffHint = asking.diff ? c.dim('  · Ctrl+O diff') : ''
    return [
      ...fit(` ${c.orange('?')} Allow ${c.bold(asking.tool)}${detail}`),
      ...(asking.reason ? fit(c.dim(`  ${asking.reason}`)) : []),
      `  ${keys}${diffHint}`,
    ]
  }
  // A suggestion shows dimmed past the cursor, which sits on its first letter.
  const typed = (prefix: string, ghost = '') => {
    const before = input.slice(0, cursor)
    const here = input[cursor] && input[cursor] !== '\n' ? input[cursor]! : undefined
    const at = here ?? (ghost[0] ? c.dim(ghost[0]) : ' ')
    const after = input.slice(cursor + (here ? 1 : 0))
    const text = `${before}${c.inverse(at)}${c.dim(ghost.slice(1))}${after}`
    return text.split('\n').flatMap((line, i) => fit(`${i === 0 ? prefix : '   '}${line}`))
  }
  if (asking?.kind === 'question') {
    const q = asking.questions[asking.index]!
    const hint = q.multiSelect ? 'numbers separated by commas, or type your own' : 'a number, or type your own'
    return [
      ...fit(` ${c.orange('?')} ${c.bold(q.question)}`),
      ...q.options.flatMap((o, i) => fit(`  ${c.cyan(String(i + 1))}. ${o.label} ${c.dim(`- ${o.description}`)}`)),
      ...typed(` ${c.dim(`(${hint})`)} ${c.bold('❯')} `),
    ]
  }
  return typed(` ${c.bold('❯')} `, ghost)
}

const InputBox = ({ width, lines, mood }: { width: number; lines: string[]; mood: Mood }) => {
  // Milo's paws rest on the top edge, centered under the face on the status
  // line (which starts one column in) and in the same orange.
  const paws = 'U─U'
  const before = Math.max(0, 1 + Math.floor((stringWidth(FACES[mood]) - paws.length) / 2) - 1)
  const after = Math.max(0, width - 2 - before - paws.length)
  const top = `┌${'─'.repeat(before)}${c.orange("U")}${"─"}${c.orange("U")}${'─'.repeat(after)}┐`
  return (
    <Box flexDirection="column" width={width}>
      <Text>{top}</Text>
      <Box borderStyle="single" borderTop={false} width={width} flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

// --- The app ---------------------------------------------------------------

export const App = ({ columns, rows }: { columns: number; rows: number }) => {
  const s = useStore()
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [selection, setSelection] = useState<Selection>()
  const dragging = useRef(false)
  const [notice, setNotice] = useState('')
  const [input, setInput] = useState('')
  const [cursor, setCursor] = useState(0)
  const [scroll, setScroll] = useState(0)
  const [diffScroll, setDiffScroll] = useState(0)
  const [frame, setFrame] = useState(0)
  const [now, setNow] = useState(Date.now())
  const history = useRef<string[]>([])
  const historyAt = useRef(-1)
  const listed = useRef<SDKSessionInfo[]>([])

  useEffect(() => {
    if (!s.busy) return
    const timer = setInterval(() => {
      setFrame(f => f + 1)
      setNow(Date.now())
    }, 120)
    return () => clearInterval(timer)
  }, [s.busy])

  const names = useMemo(() => [...new Set([...MILO_COMMANDS, ...s.commands])], [s.commands])
  const ghost = !s.pending && cursor === input.length ? completion(input, names, OPTIONS) : ''
  const boxWidth = Math.max(20, columns - 2)
  const lines = inputLines(s, input, cursor, columns, ghost)
  const inputHeight = lines.length + 2
  const workspaceHeight = Math.max(4, rows - HEADER_HEIGHT - 1 - inputHeight)
  const diff = s.showDiff ? (s.pending?.kind === 'permission' && s.pending.diff) || s.lastDiff : undefined
  const page = Math.max(1, workspaceHeight - 3)
  const innerWidth = boxWidth - 4
  const innerHeight = Math.max(1, workspaceHeight - 2)
  const log = useMemo(() => logLines(s.entries, innerWidth), [s.entries, innerWidth])
  const offset = Math.min(scroll, Math.max(0, log.length - innerHeight))
  const first = Math.max(0, log.length - offset - innerHeight)

  // Rewrapping moves every line, and a fresh conversation drops them.
  useEffect(() => setSelection(undefined), [innerWidth, s.entries.length === 0])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 2000)
    return () => clearTimeout(timer)
  }, [notice])

  const edit = (text: string, at: number) => {
    setInput(text)
    setCursor(Math.max(0, Math.min(at, text.length)))
  }

  const note = (text: string, tone: 'dim' | 'error' | 'raw' = 'raw') => push({ kind: 'note', text, tone })
  const ask = <T,>(work: (q: NonNullable<ReturnType<typeof session.current>>) => Promise<T>, show: (result: T) => string) => {
    const q = session.current()
    if (!q) return note('Claude Code is still starting.', 'dim')
    work(q)
      .then(result => note(show(result)))
      .catch((err: unknown) => note(err instanceof Error ? err.message : String(err), 'error'))
  }
  const resume = (id: string | undefined) => {
    if (!id) return note('Pick a number from /resume, or give a session id.', 'dim')
    session.restart(id).catch((err: unknown) => note(`Couldn't resume: ${err instanceof Error ? err.message : String(err)}`, 'error'))
  }

  const command = (text: string): boolean => {
    const [name, ...args] = text.split(/\s+/)
    switch (name) {
      case '/commands':
        ask(q => q.supportedCommands(), formatCommands)
        return true
      case '/agents':
        ask(q => q.supportedAgents(), formatAgents)
        return true
      case '/status': {
        const s = getState()
        ask(
          q => q.accountInfo().catch(() => undefined),
          account => formatStatus({ account, model: s.model, mode: MODE_LABELS[s.mode] ?? s.mode, sessionId: s.sessionId, contextPct: s.contextPct }),
        )
        return true
      }
      case '/mode': {
        const wanted = args[0]?.toLowerCase()
        const mode = wanted && session.MODES.find(m => m.toLowerCase() === wanted || MODE_LABELS[m]!.toLowerCase().startsWith(wanted))
        if (!wanted) note(`${MODE_LABELS[s.mode] ?? s.mode}. Choose from: ${session.MODES.join(', ')}`, 'dim')
        else if (!mode) note(`Unknown mode. Choose from: ${session.MODES.join(', ')}`, 'error')
        else
          session.setMode(mode).catch(() => note(`${MODE_LABELS[mode]} isn't available here.`, 'error'))
        return true
      }
      case '/resume':
        if (args[0]) resume(pickSession(args[0], listed.current))
        else
          recentSessions()
            .then(found => {
              listed.current = found.filter(f => f.sessionId !== getState().sessionId)
              note(formatSessions(listed.current))
            })
            .catch((err: unknown) => note(err instanceof Error ? err.message : String(err), 'error'))
        return true
      case '/continue':
        recentSessions(2)
          .then(found => {
            const last = found.find(f => f.sessionId !== getState().sessionId)
            if (last) resume(last.sessionId)
            else note('No earlier conversations in this folder.', 'dim')
          })
          .catch((err: unknown) => note(err instanceof Error ? err.message : String(err), 'error'))
        return true
      case '/exit':
      case '/quit':
        exit()
        return true
      case '/help':
        push({ kind: 'note', text: HELP, tone: 'raw' })
        return true
      case '/new':
      case '/clear':
        void session.restart()
        return true
      case '/diff':
        if (s.lastDiff) setState({ showDiff: !s.showDiff })
        else push({ kind: 'note', text: 'No file changes yet.', tone: 'dim' })
        return true
      case '/copy': {
        const replies = getState().entries.filter(e => e.kind === 'assistant')
        const back = Math.max(1, Number(args[0]) || 1)
        const reply = replies.at(-back)
        if (!reply) note(replies.length ? `Only ${replies.length} replies so far.` : 'Nothing to copy yet.', 'dim')
        else {
          copyToClipboard(stdout, reply.text.trim())
          note(`Copied ${back === 1 ? 'the last reply' : `reply ${back} back`} to the clipboard.`, 'dim')
        }
        return true
      }
      case '/milo': {
        const mood = (['thinking', 'working', 'error'] as const).find(m => args.includes(m)) ?? 'idle'
        const size: Size = (['small', 'big'] as const).find(m => args.includes(m)) ?? 'tiny'
        push({ kind: 'note', text: portrait(mood, size).join('\n'), tone: 'raw' })
        return true
      }
    }
    return false
  }

  const submit = () => {
    const text = input.trim()
    const asking = s.pending
    if (asking?.kind === 'question') {
      const q = asking.questions[asking.index]!
      const picked = text
        .split(',')
        .map(part => q.options[Number(part.trim()) - 1]?.label)
        .filter((label): label is string => !!label)
      const answers = { ...asking.answers, [q.question]: picked.length ? picked.join(', ') : text }
      if (asking.index + 1 < asking.questions.length)
        setState({ pending: { ...asking, index: asking.index + 1, answers } })
      else asking.resolve(answers)
      edit('', 0)
      return
    }
    if (!text) return
    history.current.unshift(text)
    historyAt.current = -1
    edit('', 0)
    setScroll(0)
    if (!command(text)) session.submit(text)
  }

  /** The log line and column under the mouse, kept inside the visible lines. */
  const pointAt = (x: number, y: number) => {
    const shown = Math.min(innerHeight - (offset > 0 ? 1 : 0), log.length - first)
    const row = Math.max(0, Math.min(shown - 1, y - WORKSPACE_TOP))
    return { line: first + row, col: Math.max(0, Math.min(innerWidth - 1, x - WORKSPACE_LEFT)) }
  }
  const inWorkspace = (x: number, y: number) =>
    y >= WORKSPACE_TOP && y < WORKSPACE_TOP + innerHeight && x >= WORKSPACE_LEFT - 1 && x < WORKSPACE_LEFT + innerWidth + 1

  useMouse(event => {
    if (event.kind === 'wheel') {
      const delta = event.direction * WHEEL_LINES
      if (diff) setDiffScroll(v => Math.max(0, v + delta))
      else setScroll(v => Math.max(0, v - delta))
      return
    }
    if (diff || !log.length) return
    if (event.kind === 'press') {
      dragging.current = inWorkspace(event.x, event.y)
      const at = pointAt(event.x, event.y)
      setSelection(dragging.current ? { anchor: at, head: at } : undefined)
      return
    }
    if (!dragging.current || !selection) return
    const sel = { ...selection, head: pointAt(event.x, event.y) }
    setSelection(sel)
    if (event.kind !== 'release') return
    dragging.current = false
    if (isEmpty(sel)) return setSelection(undefined)
    const text = selectedText(log, sel)
    copyToClipboard(stdout, text)
    const count = text.split('\n').length
    setNotice(`Copied ${count === 1 ? `${text.length} characters` : `${count} lines`}`)
  })

  usePaste(text => {
    const clean = text.replace(/\r\n?/g, '\n')
    edit(input.slice(0, cursor) + clean + input.slice(cursor), cursor + clean.length)
  })

  useInput((ch, key) => {
    const state = getState()
    const asking = state.pending

    if (key.ctrl && ch === 'c') {
      if (state.busy) session.interrupt()
      else if (input) edit('', 0)
      else exit()
      return
    }
    if (key.ctrl && ch === 'o') {
      if (state.showDiff) setState({ showDiff: false })
      else if (state.lastDiff || (asking?.kind === 'permission' && asking.diff)) {
        setDiffScroll(0)
        setState({ showDiff: true })
      }
      return
    }
    if (key.pageUp || key.pageDown) {
      const delta = key.pageUp ? -page : page
      if (diff) setDiffScroll(v => Math.max(0, v + delta))
      else setScroll(v => Math.max(0, v - delta))
      return
    }
    if (asking?.kind === 'permission') {
      const k = ch.toLowerCase()
      if (k === 'y') asking.resolve('yes')
      else if (k === 'a') asking.resolve('always')
      else if (k === 'n' || key.escape) asking.resolve('no')
      return
    }
    if (key.tab && key.shift) {
      void session.cycleMode()
      return
    }
    if (key.escape) {
      if (state.showDiff) setState({ showDiff: false })
      else if (state.busy) session.interrupt()
      return
    }
    if (key.ctrl && ch === 'd') {
      if (!input) exit()
      return
    }
    if (ghost && (key.tab || key.rightArrow)) return edit(input + ghost, input.length + ghost.length)
    if (key.return) return submit()
    // Most terminals send Backspace as DEL, which Ink reports as delete.
    if (key.backspace || key.delete) {
      if (cursor > 0) edit(input.slice(0, cursor - 1) + input.slice(cursor), cursor - 1)
      return
    }
    if (key.leftArrow) return setCursor(Math.max(0, cursor - 1))
    if (key.rightArrow) return setCursor(Math.min(input.length, cursor + 1))
    if (key.home || (key.ctrl && ch === 'a')) return setCursor(0)
    if (key.end || (key.ctrl && ch === 'e')) return setCursor(input.length)
    if (key.ctrl && ch === 'u') return edit('', 0)
    if (key.upArrow || key.downArrow) {
      const next = historyAt.current + (key.upArrow ? 1 : -1)
      if (next < -1 || next >= history.current.length) return
      historyAt.current = next
      const text = next === -1 ? '' : history.current[next]!
      return edit(text, text.length)
    }
    if (ch && !key.ctrl && !key.meta && !key.tab) {
      // A paste the terminal didn't bracket arrives as one chunk with CRs.
      const text = ch.replace(/\r\n?/g, '\n')
      edit(input.slice(0, cursor) + text + input.slice(cursor), cursor + text.length)
    }
  })

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box paddingX={1}>
        <Header width={boxWidth} s={s} />
      </Box>
      <Box paddingX={1}>
        {diff ? (
          <DiffView width={boxWidth} height={workspaceHeight} diff={diff} scroll={diffScroll} />
        ) : (
          <Workspace
            width={boxWidth}
            height={workspaceHeight}
            lines={log}
            first={first}
            offset={offset}
            selection={selection}
          />
        )}
      </Box>
      <StatusLine width={columns} s={s} frame={frame} now={now} notice={notice} />
      <InputBox width={columns} lines={lines} mood={s.mood} />
    </Box>
  )
}

const Root = () => {
  const { columns, rows } = useWindowSize()
  return <App columns={columns} rows={rows} />
}

export const main = async () => {
  session.start()
  // If Milo crashes, don't leave the terminal reporting mouse clicks.
  process.once('exit', () => process.stdout.write(MOUSE_OFF))
  const app = render(<Root />, { alternateScreen: true, exitOnCtrlC: false, maxFps: 30 })
  await app.waitUntilExit()
  session.close()
  const id = getState().sessionId
  if (id) console.log(c.dim(`Resume this conversation in Claude Code: claude --resume ${id}`))
  console.log(c.dim('=^oo^= Bye!'))
  process.exit(0)
}
