// Turns log entries into wrapped terminal lines for the workspace, so it can
// show any slice of them when scrolled.
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import { basename } from 'node:path'
import { mascot } from './characters.js'
import { c } from './milo.js'
import type { Entry } from './store.js'

const wrap = (text: string, width: number) => wrapAnsi(text, Math.max(10, width), { hard: true, trim: false }).split('\n')

/** Light Markdown: headings, **bold** and `code`. */
const markdown = (text: string) =>
  text
    .split('\n')
    .map(line =>
      /^#{1,6} /.test(line)
        ? c.bold(c.accent(line.replace(/^#+ /, '')))
        : line.replace(/\*\*([^*\n]+)\*\*/g, (_, s: string) => c.bold(s)).replace(/`([^`\n]+)`/g, (_, s: string) => c.focus(s)),
    )
    .join('\n')

/** Lines past which a prompt folds until clicked. */
const FOLDED_LINES = 2

/** Your prompt on its own background across the workspace, folded to two lines unless `open`. */
const promptLines = (text: string, width: number, open: boolean) => {
  let lines = wrap(`❯ ${text}`, width)
  const hidden = lines.length - FOLDED_LINES
  if (hidden > 0 && !open) {
    const more = c.dim(` … +${hidden} more line${hidden === 1 ? '' : 's'} · click to show`)
    const room = Math.max(0, width - stringWidth(more) - 1)
    // Cut the second line short enough for the hint, a character at a time for wide ones.
    let second = ''
    for (const ch of lines[1]!) {
      if (stringWidth(second + ch) > room) break
      second += ch
    }
    lines = [lines[0]!, second.trimEnd() + more]
  }
  return lines.map(line => c.lift(c.bold(line) + ' '.repeat(Math.max(0, width - stringWidth(line)))))
}

/** Whether a prompt has more lines than show while it's folded. */
export const folds = (entry: Entry, width: number) => entry.kind === 'user' && wrap(`❯ ${entry.text}`, width).length > FOLDED_LINES

const ICONS = { running: c.dim('⋯'), done: c.ok('✓'), error: c.error('✗') }

const linesFor = (entry: Entry, width: number, labelled: boolean, open: boolean): string[] => {
  switch (entry.kind) {
    case 'user':
      return [
        '',
        ...promptLines(entry.text, width, open),
        ...(entry.images ?? []).flatMap(image => wrap(c.dim(`  🖼  ${basename(image)}`), width)),
        ...(entry.files ?? []).flatMap(file => wrap(c.dim(`  📄 ${basename(file)}`), width)),
      ]
    case 'assistant':
      return [...(labelled ? ['', c.bold(c.accent(mascot().name))] : []), ...wrap(markdown(entry.text.trim()), width)]
    case 'tool': {
      const head = wrap(`  ${ICONS[entry.status]} ${c.bold(entry.name)}  ${c.dim(entry.detail)}`, width)
      if (!entry.error) return head
      const error = entry.error.split('\n').slice(0, 3).map(line => c.error(`    ${line}`))
      return [...head, ...error.flatMap(line => wrap(line, width))]
    }
    case 'note':
      if (entry.tone === 'raw') return entry.text.split('\n')
      return wrap(entry.tone === 'error' ? c.error(entry.text) : c.dim(entry.text), width)
  }
}

const cache = new WeakMap<Entry, { width: number; labelled: boolean; open: boolean; lines: string[] }>()

/** The workspace's lines, and the entry each one shows, for clicks. `opened` are prompts shown in full. */
export type Log = { lines: string[]; owners: Entry[] }

export const logLines = (entries: Entry[], width: number, opened: ReadonlySet<Entry>): Log => {
  const out: string[] = []
  const owners: Entry[] = []
  let replied = false
  entries.forEach(entry => {
    // Label the mascot's reply once per prompt, not again after each tool call.
    if (entry.kind === 'user') replied = false
    const labelled = entry.kind === 'assistant' && !replied
    if (entry.kind === 'assistant') replied = true
    const open = opened.has(entry)
    let hit = cache.get(entry)
    if (!hit || hit.width !== width || hit.labelled !== labelled || hit.open !== open) {
      hit = { width, labelled, open, lines: linesFor(entry, width, labelled, open) }
      cache.set(entry, hit)
    }
    out.push(...hit.lines)
    for (const _ of hit.lines) owners.push(entry)
  })
  return { lines: out, owners }
}
