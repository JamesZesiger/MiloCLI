// Milo's full-screen layout: a fixed header, a scrolling workspace (or a
// side-by-side diff), a status line and the input box.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, usePaste, useStdin, useStdout, useWindowSize } from 'ink'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import { basename, relative } from 'node:path'
import { CHARACTER_NAMES, mascot } from './characters.js'
import { c, type Mood } from './milo.js'
import { portrait, type Size } from './portrait.js'
import { align } from './diff.js'
import { logLines } from './render.js'
import { highlight, isEmpty, selectedText, type Selection } from './select.js'
import { characterCommand, completion, settingsCommand, themeCommand, formatAgents, formatCommands, formatSessions, formatStatus, pickSession, recentSessions } from './commands.js'
import { pasteImage } from './images.js'
import { treeRows, type Row } from './explorer.js'
import { appendOutput, changeDir, completeCommand, loadCommands, runCommand, stopCommand } from './terminal.js'
import { clickAt, column, editorKey, follow, insertText, isDirty, openDoc, reload, renderLine, save, type Doc } from './editor.js'
import { getState, push, setState, useStore, type Diff, type State } from './store.js'
import * as session from './session.js'
import { codexModels } from './codex.js'
import { settings, settingsProblems, SETTING_NAMES, SETTINGS_FILE } from './settings.js'
import { shade, THEME_NAMES } from './theme.js'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ChildProcess } from 'node:child_process'

const HEADER_HEIGHT = 8
// How long a status-line notice shows, and so how long "press again to…" waits.
const NOTICE_MS = 3000
const FRAMES = ['·', '✢', '✺', '✶', '✻', '✽'] // text characters only: ✳ shows as a green emoji in some terminals

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
  '  /model [name]  switch model; an OpenAI one (or codex) moves to Codex, a Claude one moves back',
  '  /milo [size]   show the mascot (small or big; thinking, working or error)',
  '  /char [name]   list the mascots, or switch to one: milo, boo or none',
  '  /diff          show or hide the last file change',
  '  /copy [n]      copy the last reply, or the nth from last, to the clipboard',
  '  /settings      show Milo\'s settings, or save one: /settings default_mode Auto',
  '  /theme [name]  list the color themes, or switch to one',
  '  /new           start a fresh conversation',
  '  /exit          leave',
  c.bold('Keys'),
  '  Tab            finish the command you are typing',
  '  PgUp / PgDn    scroll the workspace or the diff (the mouse wheel works too)',
  '  Ctrl+O         show or hide the last file change',
  '  Ctrl+B         show or hide the file explorer',
  '  Ctrl+V / Alt+V paste an image from the clipboard',
  '  Drag           select text in the workspace; letting go copies it',
  '  Shift+Enter    new line (Alt+Enter where the terminal sends Shift+Enter as Enter)',
  '  Shift+Tab      switch permission mode',
  '  Esc            stop a reply, or close the diff',
  '  Ctrl+C         stop a reply (twice forces it), clear the input, or leave (press twice)',
  c.bold('File explorer'),
  '  ↑ ↓ / letters  move, or jump to the next name starting with that letter',
  '  → / ←          open or close a folder',
  '  Enter / click  open or close a folder, or open a file in the editor',
  '  Esc            back to the command line (click the explorer to return)',
  c.bold('Command line (while the explorer is open)'),
  '  Enter          run what you typed in your shell; output shows in the terminal pane',
  '  Ctrl+C         stop the running command (twice kills it)',
  '  Tab / →        finish a command or path (Tab again lists the choices)',
  '  cd / clear     change folder, which the explorer and Milo follow / empty the pane',
  '  ↑ ↓            earlier commands; PgUp / PgDn scroll the output',
  c.bold('Editor'),
  '  Ctrl+S         save the file',
  '  Ctrl+W         close the file (twice drops unsaved changes)',
  '  Ctrl+Z / Ctrl+Y undo / redo',
  '  Ctrl+← / →     move by word; Ctrl+Home / End go to the start or end',
  '  Esc            back to the explorer; Ctrl+B closes both and goes back to talking to Milo',
  'Image files named in a prompt (typed or dragged in) are sent as pictures.',
  'Anything else, including Claude Code commands like /context, /compact and /usage, goes to Claude.',
  `Milo's own settings, like default_mode = "Auto", live in ${SETTINGS_FILE}.`,
].join('\n')

// Claude Code's model aliases, for when it isn't running to list its own.
const CLAUDE_MODELS = ['default', 'opus', 'sonnet', 'haiku', 'fable']

// Milo's own commands, suggested ahead of Claude Code's, and their options.
const MILO_COMMANDS = ['help', 'commands', 'resume', 'continue', 'status', 'mode', 'agents', 'model', 'milo', 'char', 'diff', 'copy', 'settings', 'theme', 'new', 'exit']
const OPTIONS: Record<string, readonly string[]> = {
  mode: session.MODES,
  model: [...CLAUDE_MODELS, 'codex', ...codexModels().map(m => m.slug)],
  milo: ['small', 'big', 'thinking', 'working', 'error'],
  settings: SETTING_NAMES,
  theme: THEME_NAMES,
  char: CHARACTER_NAMES,
}

const formatModels = (s: State, claude: string[], openai: string[]) =>
  [
    c.bold('Models'),
    `  Now      ${s.model || c.dim('starting…')}${s.provider === 'codex' ? c.dim(' through Codex') : ''}`,
    `  Claude   ${claude.join(', ')}`,
    `  OpenAI   ${openai.length ? `${openai.join(', ')}, or codex for Codex's default` : c.dim('none yet: sign in with codex login')}`,
    c.dim('/model <name> switches. Moving between Claude and OpenAI brings the conversation along.'),
  ].join('\n')

const seconds = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const shortPath = (path: string, max: number) =>
  path.length > max ? `…${path.slice(path.length - max + 1)}` : path

/** How a panel's border shows what Claude is up to: a streak circling it while working, all lit while waiting on you. */
type Glow = { kind: 'working' | 'waiting'; frame: number } | undefined

type Paint = (text: string) => string
const plain: Paint = text => text
const GLOW_HEAD: Paint = text => c.bold(c.accent(text))
const GLOW_BODY: Paint = c.accent
const GLOW_TAIL: Paint = text => c.dim(c.accent(text))
const LAP_FRAMES = 40 // frames for the streak to go once around, at 120ms a frame

/** Colors each character, one escape sequence per run of the same paint. */
const paintRun = (chars: string[], paints: Paint[]) => {
  let out = ''
  for (let i = 0; i < chars.length; ) {
    let j = i
    while (j < chars.length && paints[j] === paints[i]) j++
    out += paints[i]!(chars.slice(i, j).join(''))
    i = j
  }
  return out
}

/** A round-bordered box with its name set into the top edge; in the focus color while it has the keyboard. */
const Panel = ({
  label,
  width,
  height,
  focused = false,
  glow,
  children,
}: {
  label: string
  width: number
  height: number
  focused?: boolean
  glow?: Glow
  children: React.ReactNode
}) => {
  const w = Math.max(2, width)
  const h = Math.max(3, height)
  const base = focused ? c.focus : plain
  // Border cells are numbered clockwise from the top-left corner.
  const perimeter = 2 * (w - 1) + 2 * (h - 1)
  const step = Math.max(1, Math.round(perimeter / LAP_FRAMES))
  const length = Math.max(6, Math.round(perimeter / 10))
  const head = glow ? (glow.frame * step) % perimeter : 0
  const paint = (i: number): Paint => {
    if (!glow) return base
    if (glow.kind === 'waiting') return GLOW_HEAD
    const behind = (head - i + perimeter) % perimeter
    return behind >= length ? base : behind < length / 3 ? GLOW_HEAD : behind < (2 * length) / 3 ? GLOW_BODY : GLOW_TAIL
  }
  const range = (count: number, at: (k: number) => number) => Array.from({ length: count }, (_, k) => paint(at(k)))

  const name = ` ${label} `
  const fill = Math.max(0, w - 3 - name.length)
  const topChars = ['╭', '─', ...' '.repeat(name.length), ...'─'.repeat(fill), '╮']
  const topPaints = range(topChars.length, k => k)
  const top = `${paintRun(topChars.slice(0, 2), topPaints.slice(0, 2))}${c.bold(name)}${paintRun(topChars.slice(2 + name.length), topPaints.slice(2 + name.length))}`
  const bottom = paintRun(['╰', ...'─'.repeat(w - 2), '╯'], range(w, k => w - 1 + h - 1 + (w - 1 - k)))
  const right = range(h - 2, k => w - 1 + 1 + k).map(p => p('│'))
  const left = range(h - 2, k => perimeter - 1 - k).map(p => p('│'))
  return (
    <Box flexDirection="column" width={w} height={h}>
      <Text wrap="truncate">{top}</Text>
      <Box height={h - 2}>
        <Box width={1} flexShrink={0}>
          <Text>{left.join('\n')}</Text>
        </Box>
        <Box width={w - 2} flexDirection="column" paddingX={1} overflow="hidden">
          {children}
        </Box>
        <Box width={1} flexShrink={0}>
          <Text>{right.join('\n')}</Text>
        </Box>
      </Box>
      <Text wrap="truncate">{bottom}</Text>
    </Box>
  )
}

// --- Mouse -----------------------------------------------------------------

// Button-event mouse reporting (1002) in SGR encoding (1006): each press,
// drag and release arrives as ESC [ < button ; x ; y M (m for a release),
// with 1-based x and y. Button 64 and 65 are the wheel; 32 marks a drag.
const MOUSE_ON = '\x1b[?1002h\x1b[?1006h'
const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l'
const MOUSE_REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
const WHEEL_LINES = 3

type Mouse =
  | { kind: 'wheel'; direction: -1 | 1; x: number; y: number }
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
          if (b === 64 || b === 65) handler.current({ kind: 'wheel', direction: b === 64 ? -1 : 1, ...at })
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
    c.bold(c.accent(mascot().name)),
    mascot().about,
    c.dim(shortPath(process.cwd(), Math.max(16, width - 50))),
    '',
    c.dim('/help for commands · Ctrl+C stops a reply'),
  ]
  const right = [
    s.model || c.dim('starting…'),
    MODE_LABELS[s.mode] ?? s.mode,
    `📊 ${s.usage ?? '–'} usage`,
    `🧠 ${pct} context`,
    agents,
  ]
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
  glow,
}: {
  width: number
  height: number
  lines: string[]
  first: number
  offset: number
  selection: Selection | undefined
  glow: Glow
}) => {
  const innerHeight = Math.max(1, height - 2)
  let view: string[]
  if (!lines.length) {
    view = [
      c.dim(`Ask ${mascot().name} anything.`),
      c.dim('PgUp/PgDn scrolls · drag to select and copy · Ctrl+O shows the last file change · Ctrl+B browses files · Shift+Tab switches mode'),
    ]
  } else {
    view = lines.slice(first, first + innerHeight).map((line, i) => highlight(line, first + i, selection))
    if (offset > 0) view[view.length - 1] = c.dim(`── ${offset} more line${offset === 1 ? '' : 's'} below · PgDn ──`)
  }
  return (
    <Panel label="Workspace" width={width} height={height} glow={glow}>
      {view.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line || ' '}
        </Text>
      ))}
    </Panel>
  )
}

// --- Explorer: the working folder as a tree --------------------------------

// The explorer's box sits left of the workspace, its title on the first line
// inside the border and the tree below.
const EXPLORER_LEFT = 2 // screen column (1-based) of its left border
const TREE_TOP = WORKSPACE_TOP + 1 // screen row of the tree's first row

const Explorer = ({
  root,
  width,
  height,
  rows,
  open,
  picked,
  top,
  focused,
}: {
  width: number
  height: number
  root: string
  rows: Row[]
  open: ReadonlySet<string>
  picked: number
  top: number
  focused: boolean
}) => {
  const inner = width - 4
  const visible = rows.slice(top, top + Math.max(1, height - 3))
  const title = `${c.bold(basename(root) || root)}${rows.length ? '' : c.dim(' (empty)')}`
  return (
    <Box borderStyle="round" borderColor={focused ? shade('focus') : undefined} width={width} height={height} flexDirection="column" paddingX={1} overflow="hidden">
      <Text wrap="truncate">{title}</Text>
      {visible.map((row, i) => {
        const icon = row.dir ? (open.has(row.path) ? '▾ ' : '▸ ') : '  '
        const text = `${'  '.repeat(row.depth)}${icon}${row.name}`
        const line =
          top + i !== picked
            ? row.dir ? c.focus(text) : text
            : focused
              ? c.inverse(text + ' '.repeat(Math.max(0, inner - stringWidth(text))))
              : c.bold(text)
        return (
          <Text key={row.path} wrap="truncate">
            {line}
          </Text>
        )
      })}
    </Box>
  )
}

// --- Editor: the open file -------------------------------------------------

const EditorView = ({ width, height, doc, dirty, focused }: { width: number; height: number; doc: Doc; dirty: boolean; focused: boolean }) => {
  const body = Math.max(1, height - 3)
  const numWidth = String(doc.lines.length).length
  const textWidth = Math.max(1, width - 4 - numWidth - 1)
  const file = relative(process.cwd(), doc.path) || doc.path
  const where = c.dim(`Ln ${doc.row + 1}, Col ${column(doc.lines[doc.row]!, doc.col) + 1}`)
  const keys = c.dim(focused ? 'Ctrl+S save · Ctrl+W close · Esc files' : 'click to edit')
  const title = `${c.bold(shortPath(file, Math.max(10, width - 50)))}${dirty ? c.accent(' ●') : ''}  ${where}  ${keys}`
  return (
    <Panel label="Editor" width={width} height={height} focused={focused}>
      <Text wrap="truncate">{title}</Text>
      {doc.lines.slice(doc.top, doc.top + body).map((line, i) => {
        const n = doc.top + i
        const number = String(n + 1).padStart(numWidth)
        return (
          <Text key={n} wrap="truncate">
            {`${n === doc.row ? number : c.dim(number)} ${renderLine(line, doc.left, textWidth, focused && n === doc.row ? doc.col : undefined)}`}
          </Text>
        )
      })}
    </Panel>
  )
}

// --- Terminal: the command line's output ----------------------------------

const TerminalView = ({
  width,
  height,
  lines,
  scroll,
  cwd,
  running,
  focused,
}: {
  width: number
  height: number
  lines: string[]
  scroll: number
  cwd: string
  running: boolean
  focused: boolean
}) => {
  const inner = Math.max(1, width - 4)
  const body = Math.max(1, height - 3)
  const wrapped = useMemo(
    () => lines.flatMap(line => wrapAnsi(line.replaceAll('\r', '').replaceAll('\t', '    '), inner, { hard: true, trim: false }).split('\n')),
    [lines, inner],
  )
  const offset = Math.min(scroll, Math.max(0, wrapped.length - body))
  const start = Math.max(0, wrapped.length - offset - body)
  let view = wrapped.slice(start, start + body)
  if (!lines.length)
    view = [
      c.dim('Commands typed below run in your shell, and their output shows here.'),
      c.dim('cd changes folder · clear empties this · Ctrl+C stops a command · Ctrl+B goes back to Milo'),
    ]
  else if (offset > 0) view[view.length - 1] = c.dim(`── ${offset} more line${offset === 1 ? '' : 's'} below · PgDn ──`)
  const title = `${c.dim(shortPath(cwd, Math.max(10, width - 20)))}${running ? `  ${c.accent('running…')}` : ''}`
  return (
    <Panel label="Command" width={width} height={height} focused={focused}>
      <Text wrap="truncate">{title}</Text>
      {view.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line || ' '}
        </Text>
      ))}
    </Panel>
  )
}

// --- Diff: old and new side by side ----------------------------------------

const DiffView = ({ width, height, diff, scroll, glow }: { width: number; height: number; diff: Diff; scroll: number; glow: Glow }) => {
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
    <Panel label="Diff" width={paneWidth} height={height} glow={glow}>
      <Text wrap="truncate">{title}</Text>
      {visible.map((row, i) => (
        <Text key={i} wrap="truncate">
          {side === 'left'
            ? cell(row.left, c.error, row.kind === 'del' || row.kind === 'change')
            : cell(row.right, c.ok, row.kind === 'add' || row.kind === 'change')}
        </Text>
      ))}
    </Panel>
  )

  const more = rows.length > bodyHeight ? c.dim(` · ${top + 1}–${top + visible.length} of ${rows.length}`) : ''
  return (
    <Box width={width} height={height}>
      {pane(`${c.error('old')} ${c.dim(shortPath(file, paneWidth - 12))}`, 'left')}
      <Box width={gap} />
      {pane(`${c.ok('new')}${more}`, 'right')}
    </Box>
  )
}

// --- Status line and input box ---------------------------------------------

const StatusLine = ({ width, s, frame, now, notice }: { width: number; s: State; frame: number; now: number; notice: string }) => {
  const time = seconds(s.busy ? now - s.turnStarted : s.lastTurnMs)
  const tools = `${s.turnTools} tool${s.turnTools === 1 ? '' : 's'}${s.currentTool ? ` · ${s.currentTool}` : ''}`
  const message = notice
    ? c.ok(notice)
    : s.busy
      ? `${c.accent(FRAMES[frame % FRAMES.length]!)} ${s.status}…`
      : s.status
  return (
    <Box width={width} height={1}>
      <Text wrap="truncate">
        {`${c.accent(mascot().faces[s.mood])} ${message}  ${c.dim(time)}  ${c.dim(tools)}`}
      </Text>
    </Box>
  )
}

/** The input box's lines: a permission prompt, a question, or what you type. */
const inputLines = (s: State, input: string, cursor: number, width: number, ghost: string, prompt: string): string[] => {
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
      ...fit(` ${c.accent('?')} Allow ${c.bold(asking.tool)}${detail}`),
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
      ...fit(` ${c.accent('?')} ${c.bold(q.question)}`),
      ...q.options.flatMap((o, i) => fit(`  ${c.focus(String(i + 1))}. ${o.label} ${c.dim(`- ${o.description}`)}`)),
      ...typed(` ${c.dim(`(${hint})`)} ${c.bold('❯')} `),
    ]
  }
  return typed(prompt, ghost)
}

const InputBox = ({ width, lines, mood }: { width: number; lines: string[]; mood: Mood }) => {
  // A cat's paws rest on the top edge, centered under the face on the status
  // line (which starts above the corner) and in the same accent color.
  const paws = 'U─U'
  const before = Math.max(0, Math.floor((stringWidth(mascot().faces[mood]) - paws.length) / 2) - 1)
  const after = Math.max(0, width - 2 - before - paws.length)
  const top = mascot().paws
    ? `┌${'─'.repeat(before)}${c.accent("U")}${"─"}${c.accent("U")}${'─'.repeat(after)}┐`
    : `┌${'─'.repeat(width - 2)}┐`
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
  const typing = useRef({ input, cursor })
  typing.current = { input, cursor }
  const [scroll, setScroll] = useState(0)
  const [diffScroll, setDiffScroll] = useState(0)
  const [frame, setFrame] = useState(0)
  const [now, setNow] = useState(Date.now())
  const history = useRef<string[]>([])
  const historyAt = useRef(-1)
  // The command line keeps its own history and half-typed line.
  const shellHistory = useRef<string[]>([])
  const stash = useRef({ input: '', cursor: 0 })
  const [termLines, setTermLines] = useState<string[]>([])
  const [termCwd, setTermCwd] = useState(process.cwd())
  const [termScroll, setTermScroll] = useState(0)
  const [job, setJob] = useState<{ child: ChildProcess; stopping: boolean }>()
  const listed = useRef<SDKSessionInfo[]>([])
  const [explorerOpen, setExplorerOpen] = useState(false)
  // Where keys go: the prompt, the explorer or the editor.
  const [focus, setFocus] = useState<'input' | 'explorer' | 'editor'>('input')
  const explorerFocused = focus === 'explorer'
  const [doc, setDoc] = useState<Doc>()
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set())
  const [explorerPath, setExplorerPath] = useState<string>()
  const [explorerTop, setExplorerTop] = useState(0)
  const [treeVersion, setTreeVersion] = useState(0)
  const armed = useRef({ action: '', at: 0 })

  useEffect(() => {
    if (!s.busy) return
    const timer = setInterval(() => {
      setFrame(f => f + 1)
      setNow(Date.now())
    }, 120)
    return () => clearInterval(timer)
  }, [s.busy])

  const names = useMemo(() => [...new Set([...MILO_COMMANDS, ...s.commands])], [s.commands])
  // With the explorer open, the input box is a command line.
  const shellMode = explorerOpen
  // Command names on PATH load in the background the first time the command line opens.
  const [pathLoaded, setPathLoaded] = useState(false)
  useEffect(() => {
    if (shellMode) void loadCommands().then(() => setPathLoaded(true))
  }, [shellMode])
  const shellCompletion = useMemo(
    () => (shellMode && cursor === input.length ? completeCommand(input, termCwd, shellHistory.current) : undefined),
    [shellMode, input, cursor, termCwd, pathLoaded, treeVersion],
  )
  const ghost =
    s.pending || cursor !== input.length ? '' : shellMode ? (shellCompletion?.ghost ?? '') : completion(input, names, OPTIONS)
  const prompt = shellMode ? ` ${c.focus(basename(termCwd) || termCwd)} ${c.bold('$')} ` : ` ${c.bold('❯')} `
  const boxWidth = Math.max(20, columns - 2)
  const lines = inputLines(s, input, cursor, boxWidth, ghost, prompt)
  const inputHeight = lines.length + 2
  const workspaceHeight = Math.max(4, rows - HEADER_HEIGHT - 1 - inputHeight)
  const diff = s.showDiff ? (s.pending?.kind === 'permission' && s.pending.diff) || s.lastDiff : undefined
  const page = Math.max(1, workspaceHeight - 3)
  const explorerWidth = explorerOpen ? Math.min(40, Math.max(18, Math.floor(boxWidth / 4))) : 0
  const mainWidth = boxWidth - explorerWidth
  const workspaceLeft = WORKSPACE_LEFT + explorerWidth
  const innerWidth = mainWidth - 4
  const innerHeight = Math.max(1, workspaceHeight - 2)
  const log = useMemo(() => logLines(s.entries, innerWidth), [s.entries, innerWidth])
  const offset = Math.min(scroll, Math.max(0, log.length - innerHeight))
  const first = Math.max(0, log.length - offset - innerHeight)
  const showEditor = shellMode && !diff && !!doc
  // The terminal pane sits under the open file once there's output, or fills the space without one.
  const showTerminal = shellMode && !diff && (!doc || termLines.length > 0 || !!job)
  const terminalHeight = !showTerminal ? 0 : doc ? Math.min(workspaceHeight - 4, Math.max(5, Math.floor(workspaceHeight * 0.4))) : workspaceHeight
  const editorBoxHeight = workspaceHeight - terminalHeight
  const editorHeight = Math.max(1, editorBoxHeight - 3)
  const editorGutter = doc ? String(doc.lines.length).length + 1 : 0
  const editorWidth = Math.max(1, innerWidth - editorGutter)
  const dirty = useMemo(() => !!doc && isDirty(doc), [doc?.lines, doc?.saved])
  const glow: Glow = s.pending ? { kind: 'waiting', frame } : s.busy ? { kind: 'working', frame } : undefined

  // Claude may have changed files by the end of each turn. The open file
  // follows unless it has unsaved changes.
  useEffect(() => {
    if (s.busy) return
    setTreeVersion(v => v + 1)
    setDoc(d => d && reload(d))
  }, [s.busy])
  const tree = useMemo(
    () => (explorerOpen ? treeRows(termCwd, openFolders) : []),
    [explorerOpen, openFolders, treeVersion, termCwd],
  )
  const treeHeight = Math.max(1, workspaceHeight - 3)
  const picked = Math.max(0, tree.findIndex(row => row.path === explorerPath))
  const treeTop = Math.min(explorerTop, Math.max(0, tree.length - treeHeight))

  // A question or permission prompt needs the keyboard.
  useEffect(() => {
    if (s.pending) setFocus('input')
  }, [s.pending])

  // Rewrapping moves every line, and a fresh conversation drops them.
  useEffect(() => setSelection(undefined), [innerWidth, s.entries.length === 0])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const edit = (text: string, at: number) => {
    setInput(text)
    setCursor(Math.max(0, Math.min(at, text.length)))
  }

  /** Adds a word at the cursor, with spaces around it. */
  const insert = (word: string) => {
    const { input: text, cursor: at } = typing.current
    const gap = at > 0 && !/\s/.test(text[at - 1]!) ? ' ' : ''
    const added = `${gap}${word} `
    edit(text.slice(0, at) + added + text.slice(at), at + added.length)
  }

  /** Adds the clipboard's image at the cursor, or `fallback` (the pasted text) when there is none. */
  const pasteClipboardImage = (fallback = '') => {
    setNotice('Checking the clipboard…')
    void pasteImage().then(file => {
      // The clipboard takes a moment; insert uses where the cursor is now.
      if (file) {
        insert(file)
        return setNotice('Image pasted')
      }
      if (!fallback) return setNotice('No image on the clipboard')
      const { input: text, cursor: at } = typing.current
      edit(text.slice(0, at) + fallback + text.slice(at), at + fallback.length)
      setNotice('')
    })
  }

  const warn = (text: string) => setNotice(c.accent(text))
  /** True the second time `action` is asked for within a few seconds, for "press again to…". */
  const confirmed = (action: string) => {
    const ok = armed.current.action === action && Date.now() - armed.current.at < NOTICE_MS
    armed.current = ok ? { action: '', at: 0 } : { action, at: Date.now() }
    return ok
  }
  const docName = doc ? basename(doc.path) : ''
  /**
   * Leaves Milo. The first ask only warns when changes would be lost, or
   * always with `askFirst`, as for Ctrl+C, which is easy to press by accident.
   */
  const quit = (askFirst = false) => {
    if ((dirty || askFirst) && !confirmed('quit'))
      return warn(dirty ? `${docName} isn't saved. Press again to leave anyway.` : 'Press Ctrl+C again to leave.')
    exit()
  }

  // Closing the explorer shows the conversation again; the open file waits for it to reopen.
  const toggleExplorer = () => {
    // Chat and the command line each keep their own half-typed line.
    const other = stash.current
    stash.current = { input, cursor }
    edit(other.input, other.cursor)
    historyAt.current = -1
    setExplorerOpen(!explorerOpen)
    setFocus(explorerOpen ? 'input' : doc ? 'editor' : 'explorer')
    if (explorerOpen && dirty) warn(`${docName} isn't saved yet. Ctrl+B brings it back.`)
    else if (explorerOpen && job) setNotice('The command keeps running · Ctrl+B shows it again')
    else if (!explorerOpen && !doc) setNotice('↑↓ move · Enter opens · Esc to the command line')
  }
  const openFile = (path: string) => {
    if (doc?.path === path) return setFocus('editor')
    if (dirty) return warn(`${docName} isn't saved: Ctrl+S saves it, Ctrl+W drops the changes.`)
    const opened = openDoc(path)
    if (typeof opened === 'string') return warn(opened)
    setDoc(opened)
    setFocus('editor')
  }
  const saveDoc = (current: Doc) => {
    let result = save(current)
    if ('conflict' in result && confirmed('save')) result = save(current, true)
    if ('problem' in result) return warn(result.problem)
    setDoc(result.doc)
    setNotice(`Saved ${basename(current.path)}`)
  }
  const runShell = (text: string) => {
    if (job) return warn('A command is still running. Ctrl+C stops it.')
    if (text === 'clear' || text === 'cls') return setTermLines([])
    const echo = `${c.focus(basename(termCwd) || termCwd)} ${c.bold('$')} ${text}`
    const moved = changeDir(text, termCwd)
    if (moved) {
      setTermLines(l => [...l, echo, ...('problem' in moved ? [c.error(moved.problem)] : [])])
      // The explorer and Claude follow the command line into the new folder.
      if ('cwd' in moved) {
        setTermCwd(moved.cwd)
        setExplorerTop(0)
        session.moveTo(moved.cwd)
      }
      return
    }
    setTermLines(l => [...l, echo, ''])
    const started = Date.now()
    const child = runCommand(
      text,
      termCwd,
      chunk => setTermLines(l => appendOutput(l, chunk)),
      (code, signal) => {
        setJob(undefined)
        const time = seconds(Date.now() - started)
        const outcome = code === 0 ? c.ok(`✓ done in ${time}`) : signal ? c.accent(`stopped after ${time}`) : c.error(`✗ exit ${code} after ${time}`)
        setTermLines(l => [...(l.at(-1) === '' ? l.slice(0, -1) : l), outcome])
        // The command may have changed files.
        setTreeVersion(v => v + 1)
        setDoc(d => d && reload(d))
      },
    )
    setJob({ child, stopping: false })
  }
  const closeDoc = () => {
    if (dirty && !confirmed('close')) return warn(`${docName} isn't saved. Ctrl+W again drops the changes.`)
    setDoc(undefined)
    setFocus('explorer')
  }
  /** Picks a row, scrolling the tree just enough to show it. */
  const moveTo = (index: number) => {
    const i = Math.max(0, Math.min(tree.length - 1, index))
    const row = tree[i]
    if (!row) return
    setExplorerPath(row.path)
    setExplorerTop(Math.min(i, Math.max(treeTop, i - treeHeight + 1)))
  }
  const toggleFolder = (path: string) =>
    setOpenFolders(open => {
      const next = new Set(open)
      if (!next.delete(path)) next.add(path)
      return next
    })
  /** A folder opens or closes; a file opens in the editor. */
  const activate = (row: Row) => (row.dir ? toggleFolder(row.path) : openFile(row.path))

  const note = (text: string, tone: 'dim' | 'error' | 'raw' = 'raw') => push({ kind: 'note', text, tone })
  const ask = <T,>(work: (q: NonNullable<ReturnType<typeof session.current>>) => Promise<T>, show: (result: T) => string) => {
    const q = session.current()
    if (getState().provider === 'codex') return note("That's a Claude Code command. /model opus goes back to Claude.", 'dim')
    if (!q) return note('Claude Code is still starting.', 'dim')
    work(q)
      .then(result => note(show(result)))
      .catch((err: unknown) => note(err instanceof Error ? err.message : String(err), 'error'))
  }
  // This folder's earlier conversations, which /resume <number> picks from.
  const loadSessions = () => recentSessions().then(found => (listed.current = found))
  useEffect(() => {
    loadSessions().catch(() => {})
  }, [])

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
        const info = { model: s.model, mode: MODE_LABELS[s.mode] ?? s.mode, sessionId: s.sessionId, contextPct: s.contextPct }
        if (s.provider === 'codex') {
          note(`${formatStatus(info)}\n  Provider    OpenAI, through Codex`)
          return true
        }
        ask(
          q => q.accountInfo().catch(() => undefined),
          account => formatStatus({ account, ...info }),
        )
        return true
      }
      case '/model': {
        if (!args[0]) {
          // Both sides' models; Claude Code's own list needs it running.
          const claude = session.current()?.supportedModels().then(models => models.map(m => m.value))
          void (claude ?? Promise.resolve(CLAUDE_MODELS))
            .catch(() => CLAUDE_MODELS)
            .then(list => note(formatModels(getState(), list, codexModels().map(m => m.slug))))
          return true
        }
        session
          .useModel(args[0])
          .then(switched => {
            // A Claude model while on Claude: Claude Code's own /model sets it.
            if (!switched) session.submit(text)
          })
          .catch((err: unknown) => note(err instanceof Error ? err.message : String(err), 'error'))
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
        // A number typed before the list loads waits for it.
        ;(args[0] && listed.current.length ? Promise.resolve(listed.current) : loadSessions())
          .then(found => {
            // Leave out this conversation, which may have been saved since the list loaded.
            const others = found.filter(f => f.sessionId !== getState().sessionId)
            if (args[0]) resume(pickSession(args[0], others))
            else note(formatSessions(others))
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
        quit()
        return true
      case '/settings': {
        const result = settingsCommand(text.slice(name!.length))
        note(result.text, result.ok ? 'raw' : 'error')
        if (result.ok && args[0] === 'character') session.restyle()
        else if (result.ok && args.length && args[0] !== 'theme') note('It takes effect the next time Milo starts. /mode switches now.', 'dim')
        return true
      }
      case '/char': {
        const result = characterCommand(text.slice(name!.length))
        note(result.text, result.ok ? 'raw' : 'error')
        if (result.changed) session.restyle()
        return true
      }
      case '/theme': {
        const result = themeCommand(text.slice(name!.length))
        note(result.text, result.ok ? 'raw' : 'error')
        return true
      }
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
    ;(shellMode ? shellHistory : history).current.unshift(text)
    historyAt.current = -1
    edit('', 0)
    if (shellMode) {
      setTermScroll(0)
      return runShell(text)
    }
    setScroll(0)
    if (!command(text)) session.submit(text)
  }

  /** The log line and column under the mouse, kept inside the visible lines. */
  const pointAt = (x: number, y: number) => {
    const shown = Math.min(innerHeight - (offset > 0 ? 1 : 0), log.length - first)
    const row = Math.max(0, Math.min(shown - 1, y - WORKSPACE_TOP))
    return { line: first + row, col: Math.max(0, Math.min(innerWidth - 1, x - workspaceLeft)) }
  }
  const inWorkspace = (x: number, y: number) =>
    y >= WORKSPACE_TOP && y < WORKSPACE_TOP + innerHeight && x >= workspaceLeft - 1 && x < workspaceLeft + innerWidth + 1
  // The editor's box takes the top of the workspace, the terminal's the rest.
  const inEditor = (x: number, y: number) => showEditor && inWorkspace(x, y) && y < WORKSPACE_TOP - 1 + editorBoxHeight - 1
  const inExplorer = (x: number, y: number) =>
    explorerOpen && x >= EXPLORER_LEFT && x < EXPLORER_LEFT + explorerWidth && y >= WORKSPACE_TOP - 1 && y < WORKSPACE_TOP - 1 + workspaceHeight

  useMouse(event => {
    if (event.kind === 'wheel') {
      const delta = event.direction * WHEEL_LINES
      if (inExplorer(event.x, event.y)) setExplorerTop(Math.max(0, Math.min(tree.length - treeHeight, treeTop + delta)))
      else if (inEditor(event.x, event.y)) setDoc(d => d && { ...d, top: Math.max(0, Math.min(d.lines.length - editorHeight, d.top + delta)) })
      else if (diff) setDiffScroll(v => Math.max(0, v + delta))
      else if (showTerminal) setTermScroll(v => Math.max(0, v - delta))
      else setScroll(v => Math.max(0, v - delta))
      return
    }
    if (event.kind === 'press' && inExplorer(event.x, event.y)) {
      setFocus('explorer')
      const index = treeTop + event.y - TREE_TOP
      const row = event.y >= TREE_TOP && index < Math.min(tree.length, treeTop + treeHeight) ? tree[index] : undefined
      if (!row) return
      setExplorerPath(row.path)
      activate(row)
      return
    }
    if (event.kind === 'press' && doc && inEditor(event.x, event.y)) {
      setFocus('editor')
      // The editor's first line is below its title.
      setDoc(clickAt(doc, event.y - WORKSPACE_TOP - 1, event.x - workspaceLeft - editorGutter))
      return
    }
    if (event.kind === 'press') setFocus('input')
    if (diff || shellMode || !log.length) return
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
    if (focus === 'editor' && doc) return setDoc(follow(insertText(doc, text, false), editorHeight, editorWidth))
    // Copying a picture in a browser or app often puts its link on the clipboard
    // too, and the terminal pastes that (or nothing) instead of the picture.
    if (!text.trim() || /^\s*https?:\/\/\S+\s*$/.test(text)) return pasteClipboardImage(text.trim())
    const clean = text.replace(/\r\n?/g, '\n')
    edit(input.slice(0, cursor) + clean + input.slice(cursor), cursor + clean.length)
  })

  useInput((ch, key) => {
    const state = getState()
    const asking = state.pending

    if (key.ctrl && ch === 'c') {
      if (shellMode && job) {
        stopCommand(job.child, job.stopping)
        setJob(j => j && { ...j, stopping: true })
      } else if (state.busy) session.interrupt()
      else if (input && focus === 'input') edit('', 0)
      else quit(true)
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
    if (key.ctrl && ch === 'b') return toggleExplorer()
    if ((key.pageUp || key.pageDown) && focus !== 'editor') {
      const delta = key.pageUp ? -page : page
      if (explorerFocused) moveTo(picked + (key.pageUp ? -treeHeight : treeHeight))
      else if (diff) setDiffScroll(v => Math.max(0, v + delta))
      else if (showTerminal) setTermScroll(v => Math.max(0, v - delta))
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
    if (focus === 'editor' && doc) {
      if (key.escape) return setFocus('explorer')
      if (key.ctrl && ch === 's') return saveDoc(doc)
      if (key.ctrl && ch === 'w') return closeDoc()
      const next = editorKey(doc, ch, key, editorHeight)
      if (next) return setDoc(follow(next, editorHeight, editorWidth))
      // Keep other keys from the prompt; Shift+Tab still switches mode.
      if (!(key.tab && key.shift)) return
    }
    if (explorerFocused) {
      const row = tree[picked]
      if (key.escape) return setFocus('input')
      if (key.upArrow) return moveTo(picked - 1)
      if (key.downArrow) return moveTo(picked + 1)
      if (key.home) return moveTo(0)
      if (key.end) return moveTo(tree.length - 1)
      if (key.return || ch === ' ') return row && activate(row)
      if (key.rightArrow && row?.dir) {
        if (!openFolders.has(row.path)) return toggleFolder(row.path)
        if ((tree[picked + 1]?.depth ?? 0) > row.depth) moveTo(picked + 1)
        return
      }
      if (key.leftArrow && row) {
        if (row.dir && openFolders.has(row.path)) return toggleFolder(row.path)
        const parent = tree.findLastIndex((r, i) => i < picked && r.depth < row.depth)
        if (parent >= 0) moveTo(parent)
        return
      }
      // A letter jumps to the next name starting with it.
      if (ch && !key.ctrl && !key.meta && /^\S$/.test(ch)) {
        const starts = (r: Row) => r.name.toLowerCase().startsWith(ch.toLowerCase())
        const next = tree.findIndex((r, i) => i > picked && starts(r))
        return moveTo(next >= 0 ? next : tree.findIndex(starts))
      }
      // Keep other typing out of the hidden input; Shift+Tab and Ctrl keys still work.
      if (!key.ctrl && !key.meta && !(key.tab && key.shift)) return
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
    if ((key.ctrl || key.meta) && ch === 'v') {
      pasteClipboardImage()
      return
    }
    if (key.ctrl && ch === 'd') {
      if (!input) quit()
      return
    }
    if (ghost && (key.tab || key.rightArrow)) return edit(input + ghost, input.length + ghost.length)
    // Tab with nothing more to add lists what could come next, as shells do.
    if (shellMode && key.tab && !key.shift) {
      const choices = shellCompletion?.choices ?? []
      if (!choices.length) return
      const names = choices.map(choice => choice.trimEnd().replace(/^.*\/(?=.)/, ''))
      const shown = names.slice(0, 200).join('  ') + (names.length > 200 ? c.dim(`  …and ${names.length - 200} more`) : '')
      setTermLines(l => [...l, `${c.focus(basename(termCwd) || termCwd)} ${c.bold('$')} ${input}`, c.dim(shown)])
      setTermScroll(0)
      return
    }
    // Shift+Enter (kitty keyboard terminals) or Alt+Enter starts a new line.
    if (key.return && (key.shift || key.meta)) return edit(input.slice(0, cursor) + '\n' + input.slice(cursor), cursor + 1)
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
      const past = (shellMode ? shellHistory : history).current
      const next = historyAt.current + (key.upArrow ? 1 : -1)
      if (next < -1 || next >= past.length) return
      historyAt.current = next
      const text = next === -1 ? '' : past[next]!
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
        {explorerOpen && (
          <Explorer
            root={termCwd}
            width={explorerWidth}
            height={workspaceHeight}
            rows={tree}
            open={openFolders}
            picked={picked}
            top={treeTop}
            focused={explorerFocused}
          />
        )}
        {diff ? (
          <DiffView width={mainWidth} height={workspaceHeight} diff={diff} scroll={diffScroll} glow={glow} />
        ) : shellMode ? (
          <Box flexDirection="column" width={mainWidth}>
            {showEditor && <EditorView width={mainWidth} height={editorBoxHeight} doc={doc} dirty={dirty} focused={focus === 'editor'} />}
            {showTerminal && (
              <TerminalView width={mainWidth} height={terminalHeight} lines={termLines} scroll={termScroll} cwd={termCwd} running={!!job} focused={focus === 'input'} />
            )}
          </Box>
        ) : (
          <Workspace
            width={mainWidth}
            height={workspaceHeight}
            lines={log}
            first={first}
            offset={offset}
            selection={selection}
            glow={glow}
          />
        )}
      </Box>
      <Box paddingX={1} flexDirection="column">
        <StatusLine width={boxWidth} s={s} frame={frame} now={now} notice={notice} />
        <InputBox width={boxWidth} lines={lines} mood={s.mood} />
      </Box>
    </Box>
  )
}

const Root = () => {
  const { columns, rows } = useWindowSize()
  return <App columns={columns} rows={rows} />
}

export const main = async () => {
  session.start()
  for (const text of settingsProblems) push({ kind: 'note', text, tone: 'error' })
  const mode = settings.defaultMode
  if (mode)
    session
      .setMode(mode)
      .catch(() => push({ kind: 'note', text: `${MODE_LABELS[mode]} isn't available here, so Milo started in the default mode.`, tone: 'error' }))
  // If Milo crashes, don't leave the terminal reporting mouse clicks.
  process.once('exit', () => process.stdout.write(MOUSE_OFF))
  const app = render(<Root />, { alternateScreen: true, exitOnCtrlC: false, maxFps: 30, kittyKeyboard: { mode: 'auto' } })
  await app.waitUntilExit()
  session.close()
  const { sessionId: id, provider } = getState()
  if (id && provider === 'codex') console.log(c.dim(`Resume this conversation in Codex: codex resume ${id}`))
  else if (id) console.log(c.dim(`Resume this conversation in Claude Code: claude --resume ${id}`))
  console.log(c.dim('=^oo^= Bye!'))
  process.exit(0)
}
