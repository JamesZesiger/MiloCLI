// Milo's own notes on conversations, kept in ~/.milo/sessions.json: which are
// pinned to the top of the sessions list, and the names you gave them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const MARKS_FILE = join(homedir(), '.milo', 'sessions.json')

type Marks = { pinned: string[]; titles: Record<string, string> }

const load = (): Marks => {
  try {
    const raw = JSON.parse(readFileSync(MARKS_FILE, 'utf8')) as Partial<Marks>
    const pinned = Array.isArray(raw.pinned) ? raw.pinned.filter((id): id is string => typeof id === 'string') : []
    const titles = raw.titles && typeof raw.titles === 'object' ? raw.titles : {}
    return { pinned, titles }
  } catch {
    // Not there yet, or not JSON: start with no marks.
    return { pinned: [], titles: {} }
  }
}

let marks = load()

/** Writes the marks, keeping the old ones if that fails. Returns a problem, or nothing when it worked. */
const save = (next: Marks): string | void => {
  try {
    mkdirSync(dirname(MARKS_FILE), { recursive: true })
    writeFileSync(MARKS_FILE, `${JSON.stringify(next, null, 2)}\n`)
  } catch (err) {
    return `Couldn't save ${MARKS_FILE}: ${err instanceof Error ? err.message : String(err)}`
  }
  marks = next
}

export const isPinned = (id: string | undefined) => !!id && marks.pinned.includes(id)
export const pinnedIds = () => marks.pinned
export const titleOf = (id: string | undefined) => (id ? marks.titles[id] : undefined)

export const togglePin = (id: string) =>
  save({ ...marks, pinned: isPinned(id) ? marks.pinned.filter(p => p !== id) : [...marks.pinned, id] })

/** Names a conversation; an empty name goes back to its first prompt. */
export const setTitle = (id: string, title: string) => {
  const titles = { ...marks.titles }
  if (title) titles[id] = title
  else delete titles[id]
  return save({ ...marks, titles })
}

/** Drops a deleted conversation's pin and name. */
export const forget = (id: string) => {
  if (!isPinned(id) && !titleOf(id)) return
  const { [id]: _, ...titles } = marks.titles
  return save({ pinned: marks.pinned.filter(p => p !== id), titles })
}
