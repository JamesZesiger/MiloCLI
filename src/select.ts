// Mouse selection in the workspace: a range of log lines and columns that
// Milo highlights itself and copies as plain text, without the box borders.
import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'

/** A spot in the log: an index into its wrapped lines and a screen column. */
export type Point = { line: number; col: number }
export type Selection = { anchor: Point; head: Point }

const before = (a: Point, b: Point) => a.line < b.line || (a.line === b.line && a.col < b.col)

/** The selection's first and last points, whichever way it was dragged. */
const ordered = ({ anchor, head }: Selection): [Point, Point] => (before(head, anchor) ? [head, anchor] : [anchor, head])

/** The columns of `line` that are selected, from (inclusive) to (exclusive). */
const span = (sel: Selection, line: number): [number, number] | undefined => {
  const [start, end] = ordered(sel)
  if (line < start.line || line > end.line) return undefined
  return [line === start.line ? start.col : 0, line === end.line ? end.col + 1 : Infinity]
}

/** Splits plain text at screen columns, keeping wide characters whole. */
const cut = (text: string, from: number, to: number) => {
  let col = 0
  const parts = ['', '', '']
  for (const ch of text) {
    parts[col < from ? 0 : col < to ? 1 : 2] += ch
    col += stringWidth(ch)
  }
  return parts as [string, string, string]
}

// Reverse video, even with NO_COLOR: without it a selection can't be seen.
const inverse = (text: string) => `\x1b[7m${text}\x1b[27m`

/** A log line with its selected part shown inverted. */
export const highlight = (line: string, index: number, sel: Selection | undefined) => {
  const cols = sel && span(sel, index)
  if (!cols) return line
  const [head, picked, tail] = cut(stripVTControlCharacters(line), ...cols)
  return picked ? head + inverse(picked) + tail : line
}

export const isEmpty = ({ anchor, head }: Selection) => anchor.line === head.line && anchor.col === head.col

/** The selected text, one line per log line, without trailing spaces. */
export const selectedText = (lines: string[], sel: Selection) => {
  const [start, end] = ordered(sel)
  const out: string[] = []
  for (let i = start.line; i <= end.line && i < lines.length; i++)
    out.push(cut(stripVTControlCharacters(lines[i]!), ...span(sel, i)!)[1].trimEnd())
  return out.join('\n')
}
