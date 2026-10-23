// The full-screen app's state. Each open session (a slot) has one plain
// object, replaced on every change, that its session writes; the screen shows
// the active slot's and lists the rest.
import { useSyncExternalStore } from 'react'
import type { Mood } from './milo.js'

export type Entry =
  | { kind: 'user'; text: string; images?: string[]; files?: string[] }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      detail: string
      status: 'running' | 'done' | 'error'
      error?: string
      /** The file the tool worked on, and the change it made, which a click on it shows. */
      file?: string
      diff?: Diff
    }
  | { kind: 'note'; text: string; tone?: 'dim' | 'error' | 'raw' }

/** A file change; `start` is the file's line number of the first line shown. */
export type Diff = { file: string; before: string; after: string; start: number }

export type Question = {
  question: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

export type Choice = 'yes' | 'no' | 'always'

export type Pending =
  | {
      kind: 'permission'
      tool: string
      detail: string
      reason?: string
      diff?: Diff
      canAlways: boolean
      resolve: (choice: Choice) => void
    }
  | {
      kind: 'question'
      questions: Question[]
      index: number
      answers: Record<string, string>
      resolve: (answers: Record<string, string>) => void
    }

export type Provider = 'claude' | 'codex'

export type State = {
  entries: Entry[]
  /** Who answers: Claude Code, or OpenAI's models through Codex. */
  provider: Provider
  model: string
  contextPct: number | undefined
  /** Percent of the 5-hour plan limit on a subscription, or the session's cost. */
  usage: string | undefined
  mode: string
  agents: number
  busy: boolean
  mood: Mood
  /** What the status line says: a spinner verb while busy, the outcome after. */
  status: string
  turnStarted: number
  lastTurnMs: number
  turnTools: number
  currentTool: string | undefined
  lastDiff: Diff | undefined
  showDiff: boolean
  pending: Pending | undefined
  sessionId: string | undefined
  /** Claude Code's command and skill names, for completing what's typed. */
  commands: string[]
  /** The folder this session works in. */
  cwd: string
}

const fresh = (cwd: string): State => ({
  entries: [],
  provider: 'claude',
  model: '',
  contextPct: undefined,
  usage: undefined,
  mode: 'default',
  agents: 0,
  busy: false,
  mood: 'idle',
  status: 'Ready',
  turnStarted: 0,
  lastTurnMs: 0,
  turnTools: 0,
  currentTool: undefined,
  lastDiff: undefined,
  showDiff: false,
  pending: undefined,
  sessionId: undefined,
  commands: [],
  cwd,
})

// --- Slots: one per open session -------------------------------------------

export type Slot = { key: string; state: State }

// Replaced, not changed, on every update, so the screen can tell it moved.
let slots: Slot[] = [{ key: 'first', state: fresh(process.cwd()) }]
let active = 'first'
let nextKey = 0

const listeners = new Set<() => void>()
const changed = () => listeners.forEach(listener => listener())

const find = (key: string) => slots.find(slot => slot.key === key)

/** A new slot working in `cwd`, not yet shown; returns its key. */
export const addSlot = (cwd: string, patch: Partial<State> = {}) => {
  const key = `slot-${++nextKey}`
  slots = [...slots, { key, state: { ...fresh(cwd), ...patch } }]
  changed()
  return key
}

export const removeSlot = (key: string) => {
  slots = slots.filter(slot => slot.key !== key)
  if (active === key && slots[0]) active = slots[0].key
  changed()
}

export const showSlot = (key: string) => {
  if (!find(key) || active === key) return
  active = key
  changed()
}

export const activeKey = () => active
export const getSlots = () => slots

/** Reads and writes for one slot, whether or not it's the one on screen. */
export const storeFor = (key: string) => {
  const getState = () => find(key)?.state ?? fresh(process.cwd())
  const setState = (patch: Partial<State> | ((s: State) => Partial<State>)) => {
    const slot = find(key)
    if (!slot) return // closed while a reply was still arriving
    const state = { ...slot.state, ...(typeof patch === 'function' ? patch(slot.state) : patch) }
    slots = slots.map(s => (s.key === key ? { key, state } : s))
    changed()
  }
  const push = (entry: Entry) => setState(s => ({ entries: [...s.entries, entry] }))
  return { getState, setState, push }
}
export type SlotStore = ReturnType<typeof storeFor>

// The slot on screen.
export const getState = () => find(active)!.state
export const setState: SlotStore['setState'] = patch => storeFor(active).setState(patch)
export const push = (entry: Entry) => storeFor(active).push(entry)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const useStore = () => useSyncExternalStore(subscribe, getState)
export const useSlots = () => useSyncExternalStore(subscribe, getSlots)
