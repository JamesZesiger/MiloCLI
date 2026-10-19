// The full-screen app's state: one plain object, replaced on every change,
// that the session writes and the screen reads.
import { useSyncExternalStore } from 'react'
import type { Mood } from './milo.js'

export type Entry =
  | { kind: 'user'; text: string; images?: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; detail: string; status: 'running' | 'done' | 'error'; error?: string }
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

export type State = {
  entries: Entry[]
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
}

let state: State = {
  entries: [],
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
}

const listeners = new Set<() => void>()

export const getState = () => state

export const setState = (patch: Partial<State> | ((s: State) => Partial<State>)) => {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  listeners.forEach(listener => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const useStore = () => useSyncExternalStore(subscribe, getState)

export const push = (entry: Entry) => setState(s => ({ entries: [...s.entries, entry] }))
