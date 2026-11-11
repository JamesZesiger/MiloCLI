// Markdown in Claude's replies, drawn for the terminal: headings, lists,
// quotes, rules, code blocks and tables, with **bold**, *italics*, ~~strikes~~,
// `code` and links inside them.
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import { c } from './milo.js'

const wrap = (text: string, width: number) => wrapAnsi(text, Math.max(1, width), { hard: true, trim: false }).split('\n')

/** The marks within a line. Code and links are set aside first, so marks inside them stay as typed. */
const inline = (text: string) => {
  const kept: string[] = []
  const keep = (styled: string) => `\0${kept.push(styled) - 1}\0`
  return text
    .replace(/`([^`\n]+)`/g, (_, code: string) => keep(c.focus(code)))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
      keep(label === url ? c.focus(url) : `${label} ${c.dim(`(${url})`)}`),
    )
    .replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*|__(\S(?:[^_\n]*\S)?)__/g, (_, a?: string, b?: string) => c.bold(a ?? b!))
    .replace(/(?<![\w*])\*(\S(?:[^*\n]*\S)?)\*(?!\w)|(?<!\w)_(\S(?:[^_\n]*\S)?)_(?!\w)/g, (_, a?: string, b?: string) =>
      c.italic(a ?? b!),
    )
    .replace(/~~([^~\n]+)~~/g, (_, struck: string) => c.strike(struck))
    .replace(/\0(\d+)\0/g, (_, i: string) => kept[Number(i)]!)
}

/** A table row's cells; `\|` is a pipe inside a cell. */
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replaceAll('\\|', '|'))

const isRow = (line: string) => line.includes('|') && !!line.trim()
/** The line under a table's header, like |---|:--:|, which also says how each column lines up. */
const divider = (line: string) => {
  const marks = cells(line)
  if (!line.includes('|') || !marks.every(mark => /^:?-+:?$/.test(mark))) return undefined
  return marks.map(mark => (mark.endsWith(':') ? (mark.startsWith(':') ? 'center' : 'right') : 'left'))
}
type Align = NonNullable<ReturnType<typeof divider>>[number]

const pad = (text: string, width: number, align: Align) => {
  const gap = Math.max(0, width - stringWidth(text))
  const before = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0
  return ' '.repeat(before) + text + ' '.repeat(gap - before)
}

/** Column widths that fit `room`: narrow columns keep theirs, and the wide ones share what's left. */
const fit = (natural: number[], room: number) => {
  const widths = [...natural]
  let left = room
  let shared = natural.length
  for (const j of natural.map((_, j) => j).sort((a, b) => natural[a]! - natural[b]!)) {
    widths[j] = Math.max(3, Math.min(natural[j]!, Math.floor(left / shared--)))
    left -= widths[j]!
  }
  return widths
}

/** A table in box lines, its cells wrapped when it's wider than the workspace. */
const table = (rows: string[][], aligns: Align[], width: number) => {
  const count = Math.max(...rows.map(row => row.length))
  const styled = rows.map((row, i) =>
    Array.from({ length: count }, (_, j) => (i === 0 ? c.bold(inline(row[j] ?? '')) : inline(row[j] ?? ''))),
  )
  const natural = Array.from({ length: count }, (_, j) => Math.max(1, ...styled.map(row => stringWidth(row[j]!))))
  const widths = fit(natural, width - 3 * count - 1)
  const border = (left: string, middle: string, right: string) =>
    c.dim(left + widths.map(w => '─'.repeat(w + 2)).join(middle) + right)
  const lines = [border('┌', '┬', '┐')]
  styled.forEach((row, i) => {
    const wrapped = row.map((cell, j) => wrapAnsi(cell, widths[j]!, { hard: true, trim: true }).split('\n'))
    const height = Math.max(...wrapped.map(cell => cell.length))
    for (let k = 0; k < height; k++)
      lines.push(
        c.dim('│') + wrapped.map((cell, j) => ` ${pad(cell[k] ?? '', widths[j]!, aligns[j] ?? 'left')} `).join(c.dim('│')) + c.dim('│'),
      )
    if (i === 0) lines.push(border('├', '┼', '┤'))
  })
  lines.push(border('└', '┴', '┘'))
  return lines
}

/** Text wrapped to `width` after `first`, with later lines lined up under where the text starts. */
const hanging = (first: string, text: string, width: number) => {
  const indent = ' '.repeat(stringWidth(first))
  return wrap(inline(text), width - indent.length).map((line, i) => (i ? indent : first) + line)
}

/** A reply's Markdown as terminal lines no wider than `width`. */
export const markdown = (text: string, width: number): string[] => {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line)
    if (fence) {
      if (fence[2]) out.push(c.dim(`  ${fence[2]}`))
      // A block still streaming in has no closing fence yet.
      while (++i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) out.push(...wrap(c.focus(`  ${lines[i]}`), width))
      continue
    }
    const aligns = isRow(line) && i + 1 < lines.length ? divider(lines[i + 1]!) : undefined
    if (aligns) {
      const rows = [cells(line)]
      i++
      while (i + 1 < lines.length && isRow(lines[i + 1]!)) rows.push(cells(lines[++i]!))
      out.push(...table(rows, aligns, width))
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    const quote = /^\s*>\s?(.*)$/.exec(line)
    const item = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line)
    if (heading) out.push(...wrap(c.bold(c.accent(heading[1]!.replace(/\*\*|__|`/g, ''))), width))
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) out.push(c.dim('─'.repeat(Math.max(1, width))))
    else if (quote) out.push(...wrap(inline(quote[1]!), width - 2).map(text => c.dim('│ ') + c.italic(text)))
    else if (item) {
      const [, indent, marker, done, rest] = item
      const bullet = done ? (done === ' ' ? '☐' : '☑') : /\d/.test(marker!) ? marker! : '•'
      out.push(...hanging(`${indent}${/\d/.test(bullet) ? bullet : c.accent(bullet)} `, rest!, width))
    } else out.push(...wrap(inline(line), width))
  }
  return out
}
