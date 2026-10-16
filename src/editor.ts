// The workspace's code editor: one open file, its lines, the cursor and the
// view. Each edit is a function from one doc to the next, so undo keeps the
// old lines as they were.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import stringWidth from 'string-width'
import type { Key } from 'ink'

const TAB = 4 // columns a tab fills, at most
const MAX_BYTES = 2 * 1024 * 1024
const MAX_UNDO = 200

type Snap = { lines: string[]; row: number; col: number }

export type Doc = Snap & {
  path: string
  /** The screen column up and down aim for, kept across short lines. */
  goal: number
  /** The first line and screen column in view. */
  top: number
  left: number
  /** The file's text when opened or last saved. */
  saved: string
  eol: '\n' | '\r\n'
  /** What Tab inserts: a tab, or as many spaces as the file indents by. */
  indent: string
  undo: Snap[]
  redo: Snap[]
  /** The last edit was typing, so more typing joins its undo step. */
  typing: boolean
}

// --- Characters and screen columns -----------------------------------------

/** A character's width at screen column `at`; control characters show as one dot. */
const charWidth = (ch: string, at: number) => (ch === '\t' ? TAB - (at % TAB) : ch < ' ' || ch === '\x7f' ? 1 : stringWidth(ch))

/** The screen column of index `col` in `line`, with tabs expanded. */
export const column = (line: string, col: number) => {
  let at = 0
  for (const ch of line.slice(0, col)) at += charWidth(ch, at)
  return at
}

/** The index in `line` of the character at screen column `target`, or its end. */
const indexAt = (line: string, target: number) => {
  let at = 0
  let i = 0
  for (const ch of line) {
    const next = at + charWidth(ch, at)
    if (next > target) return i
    at = next
    i += ch.length
  }
  return line.length
}

// Steps over whole characters, so the cursor never splits an emoji.
const prevIndex = (s: string, i: number) => (i >= 2 && /[\uDC00-\uDFFF]/.test(s[i - 1]!) && /[\uD800-\uDBFF]/.test(s[i - 2]!) ? i - 2 : i - 1)
const nextIndex = (s: string, i: number) => i + ((s.codePointAt(i) ?? 0) > 0xffff ? 2 : 1)

const inverse = (text: string) => `\x1b[7m${text}\x1b[27m`

/** A line as it shows from screen column `left`, `width` wide, with the cursor at index `cursor`. */
export const renderLine = (line: string, left: number, width: number, cursor?: number) => {
  let out = ''
  let at = 0
  let i = 0
  for (const ch of line) {
    const w = charWidth(ch, at)
    if (at >= left && at + w <= left + width) {
      const shown = ch === '\t' ? ' '.repeat(w) : ch < ' ' || ch === '\x7f' ? '·' : ch
      out += i === cursor ? inverse(shown) : shown
    }
    at += w
    i += ch.length
    if (at >= left + width) break
  }
  if (cursor === line.length && at >= left && at < left + width) out += inverse(' ')
  return out
}

// --- Opening and saving ----------------------------------------------------

const read = (path: string) => readFileSync(path, 'utf8')

/** How the file indents: a tab, or its smallest run of two or more leading spaces. */
const guessIndent = (lines: string[]) => {
  if (lines.some(line => line.startsWith('\t'))) return '\t'
  const runs = lines.map(line => /^( +)\S/.exec(line)?.[1]!.length ?? 0).filter(n => n >= 2)
  return ' '.repeat(runs.length ? Math.min(4, ...runs) : 2)
}

const fromText = (path: string, text: string): Doc => {
  const lines = text.split(/\r?\n/)
  return {
    path,
    lines,
    row: 0,
    col: 0,
    goal: 0,
    top: 0,
    left: 0,
    saved: text,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    indent: guessIndent(lines.slice(0, 500)),
    undo: [],
    redo: [],
    typing: false,
  }
}

/** Opens a file to edit, or says why it can't be. */
export const openDoc = (path: string): Doc | string => {
  try {
    if (statSync(path).size > MAX_BYTES) return `${basename(path)} is over 2 MB, too big to edit here.`
    const text = read(path)
    if (text.includes('\0')) return `${basename(path)} looks like a binary file.`
    return fromText(path, text)
  } catch (err) {
    return `Couldn't open ${basename(path)}: ${err instanceof Error ? err.message : String(err)}`
  }
}

export const textOf = (doc: Doc) => doc.lines.join(doc.eol)

export const isDirty = (doc: Doc) => textOf(doc) !== doc.saved

/** The file's text on disk now, or undefined if it's gone. */
const onDisk = (path: string) => {
  try {
    return existsSync(path) ? read(path) : undefined
  } catch {
    return undefined
  }
}

export type Saved = { doc: Doc } | { problem: string; conflict?: true }

/** Writes the doc to its file. Unless `force`, it won't overwrite changes made on disk since. */
export const save = (doc: Doc, force = false): Saved => {
  const disk = onDisk(doc.path)
  if (!force && disk !== undefined && disk !== doc.saved)
    return { conflict: true, problem: `${basename(doc.path)} changed on disk. Ctrl+S again overwrites it.` }
  const text = textOf(doc)
  try {
    writeFileSync(doc.path, text)
  } catch (err) {
    return { problem: `Couldn't save ${basename(doc.path)}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { doc: { ...doc, saved: text } }
}

/** The doc with the file's text as it is on disk now, if that differs and nothing is unsaved. */
export const reload = (doc: Doc): Doc => {
  const disk = onDisk(doc.path)
  if (disk === undefined || disk === doc.saved || isDirty(doc)) return doc
  const fresh = fromText(doc.path, disk)
  const row = Math.min(doc.row, fresh.lines.length - 1)
  return { ...fresh, row, col: Math.min(doc.col, fresh.lines[row]!.length), top: doc.top, left: doc.left }
}

// --- Moving ----------------------------------------------------------------

/** Moves the cursor; `keepGoal` is for up and down, which aim at the same column. */
const moveTo = (doc: Doc, row: number, col: number, keepGoal = false): Doc => {
  const r = Math.max(0, Math.min(doc.lines.length - 1, row))
  const line = doc.lines[r]!
  const c = Math.max(0, Math.min(line.length, col))
  return { ...doc, row: r, col: c, goal: keepGoal ? doc.goal : column(line, c), typing: false }
}

const vertical = (doc: Doc, rows: number) => {
  const row = Math.max(0, Math.min(doc.lines.length - 1, doc.row + rows))
  return moveTo(doc, row, indexAt(doc.lines[row]!, doc.goal), true)
}

const wordLeft = (doc: Doc) => {
  if (doc.col === 0) return doc.row > 0 ? moveTo(doc, doc.row - 1, Infinity) : doc
  const before = doc.lines[doc.row]!.slice(0, doc.col)
  return moveTo(doc, doc.row, /(\w+|[^\w\s]+)\s*$/.exec(before)?.index ?? 0)
}

const wordRight = (doc: Doc) => {
  const line = doc.lines[doc.row]!
  if (doc.col === line.length) return doc.row < doc.lines.length - 1 ? moveTo(doc, doc.row + 1, 0) : doc
  const after = line.slice(doc.col)
  return moveTo(doc, doc.row, doc.col + (/^\s*(\w+|[^\w\s]+)/.exec(after)?.[0].length ?? after.length))
}

/** Home goes to the line's first non-space, or to its very start from there. */
const home = (doc: Doc) => {
  const line = doc.lines[doc.row]!
  const first = line.search(/\S/)
  const start = first < 0 ? line.length : first
  return moveTo(doc, doc.row, doc.col === start ? 0 : start)
}

/** Scrolls just enough to show the cursor in a view `height` lines by `width` columns. */
export const follow = (doc: Doc, height: number, width: number): Doc => {
  const at = column(doc.lines[doc.row]!, doc.col)
  const top = Math.min(doc.row, Math.max(doc.top, doc.row - height + 1))
  const left = Math.min(at, Math.max(doc.left, at - width + 1))
  return top === doc.top && left === doc.left ? doc : { ...doc, top, left }
}

/** Puts the cursor at a spot in the view, as a mouse click does. */
export const clickAt = (doc: Doc, viewRow: number, viewCol: number) => {
  const row = Math.max(0, Math.min(doc.lines.length - 1, doc.top + viewRow))
  return moveTo(doc, row, indexAt(doc.lines[row]!, doc.left + Math.max(0, viewCol)))
}

// --- Editing ---------------------------------------------------------------

/** Applies a change to the lines, saving the old ones for undo. Typing joins one undo step. */
const change = (doc: Doc, next: Snap, typing = false): Doc => {
  const undo = typing && doc.typing ? doc.undo : [...doc.undo.slice(1 - MAX_UNDO), { lines: doc.lines, row: doc.row, col: doc.col }]
  return { ...doc, ...next, goal: column(next.lines[next.row]!, next.col), undo, redo: [], typing }
}

const replaceLines = (lines: string[], from: number, count: number, add: string[]) => [
  ...lines.slice(0, from),
  ...add,
  ...lines.slice(from + count),
]

/** Inserts text at the cursor; newlines in it split the line. */
export const insertText = (doc: Doc, text: string, typing = true): Doc => {
  const line = doc.lines[doc.row]!
  const before = line.slice(0, doc.col)
  const after = line.slice(doc.col)
  const parts = text.split(/\r?\n/)
  const last = parts.at(-1)!
  const added = parts.length === 1 ? [before + text + after] : [before + parts[0], ...parts.slice(1, -1), last + after]
  const row = doc.row + parts.length - 1
  const col = (parts.length === 1 ? before.length : 0) + last.length
  return change(doc, { lines: replaceLines(doc.lines, doc.row, 1, added), row, col }, typing && parts.length === 1)
}

/** Enter: a new line, indented like this one. */
const newline = (doc: Doc) => {
  const indent = /^\s*/.exec(doc.lines[doc.row]!.slice(0, doc.col))![0]
  return insertText(doc, `\n${indent}`, false)
}

const backspace = (doc: Doc) => {
  const line = doc.lines[doc.row]!
  if (doc.col > 0) {
    const from = prevIndex(line, doc.col)
    return change(doc, { lines: replaceLines(doc.lines, doc.row, 1, [line.slice(0, from) + line.slice(doc.col)]), row: doc.row, col: from }, true)
  }
  if (doc.row === 0) return doc
  const above = doc.lines[doc.row - 1]!
  return change(doc, { lines: replaceLines(doc.lines, doc.row - 1, 2, [above + line]), row: doc.row - 1, col: above.length })
}

const forwardDelete = (doc: Doc) => {
  const line = doc.lines[doc.row]!
  if (doc.col < line.length) {
    const to = nextIndex(line, doc.col)
    return change(doc, { lines: replaceLines(doc.lines, doc.row, 1, [line.slice(0, doc.col) + line.slice(to)]), row: doc.row, col: doc.col }, true)
  }
  if (doc.row === doc.lines.length - 1) return doc
  return change(doc, { lines: replaceLines(doc.lines, doc.row, 2, [line + doc.lines[doc.row + 1]!]), row: doc.row, col: doc.col })
}

const undo = (doc: Doc): Doc => {
  const last = doc.undo.at(-1)
  if (!last) return doc
  const now = { lines: doc.lines, row: doc.row, col: doc.col }
  return { ...doc, ...last, goal: column(last.lines[last.row]!, last.col), undo: doc.undo.slice(0, -1), redo: [...doc.redo, now], typing: false }
}

const redo = (doc: Doc): Doc => {
  const next = doc.redo.at(-1)
  if (!next) return doc
  const now = { lines: doc.lines, row: doc.row, col: doc.col }
  return { ...doc, ...next, goal: column(next.lines[next.row]!, next.col), undo: [...doc.undo, now], redo: doc.redo.slice(0, -1), typing: false }
}

/** The doc after a key, or undefined when the key isn't the editor's. `page` is the view's height. */
export const editorKey = (doc: Doc, input: string, key: Key, page: number): Doc | undefined => {
  if (key.ctrl && input === 'z') return undo(doc)
  if (key.ctrl && input === 'y') return redo(doc)
  if (key.upArrow) return vertical(doc, -1)
  if (key.downArrow) return vertical(doc, 1)
  if (key.pageUp) return vertical(doc, -page)
  if (key.pageDown) return vertical(doc, page)
  if (key.leftArrow) {
    if (key.ctrl || key.meta) return wordLeft(doc)
    if (doc.col > 0) return moveTo(doc, doc.row, prevIndex(doc.lines[doc.row]!, doc.col))
    return doc.row > 0 ? moveTo(doc, doc.row - 1, Infinity) : doc
  }
  if (key.rightArrow) {
    if (key.ctrl || key.meta) return wordRight(doc)
    const line = doc.lines[doc.row]!
    if (doc.col < line.length) return moveTo(doc, doc.row, nextIndex(line, doc.col))
    return doc.row < doc.lines.length - 1 ? moveTo(doc, doc.row + 1, 0) : doc
  }
  if (key.home) return key.ctrl ? moveTo(doc, 0, 0) : home(doc)
  if (key.end) return key.ctrl ? moveTo(doc, Infinity, Infinity) : moveTo(doc, doc.row, Infinity)
  if (key.return) return newline(doc)
  if (key.backspace) return backspace(doc)
  if (key.delete) return forwardDelete(doc)
  if (key.tab && !key.shift) return insertText(doc, doc.indent)
  // A paste the terminal didn't bracket arrives as one chunk with CRs.
  if (input && !key.ctrl && !key.meta) return insertText(doc, input.replace(/\r\n?/g, '\n'), input.length === 1)
  return undefined
}
