// What Milo needs from a model provider. Milo runs the conversation: it sends
// prompts, shows what comes back, asks the user before actions and decides
// what happens between turns. A provider only talks to its model and reports
// back through events, so Claude Code and Codex look the same to the rest of
// Milo.
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { Content } from './images.js'
import type { Choice, Diff, Provider as ProviderId, Question } from './store.js'

export type { ProviderId }

export type ProviderEvent =
  /** The provider's id for this conversation, for resuming it later. */
  | { type: 'session'; id: string }
  /** Header numbers; any left out stay as they were. */
  | { type: 'header'; model?: string; mode?: string; contextPct?: number; usage?: string }
  /** Slash commands and skills the provider knows, for completing what's typed. */
  | { type: 'commands'; names: string[] }
  /** Part of a reply, as it streams in. */
  | { type: 'text'; text: string }
  /** A whole reply. */
  | { type: 'reply'; text: string }
  /**
   * A tool call starting or changing. The first event for an id needs a name;
   * later ones only change what they give.
   */
  | { type: 'tool'; id: string; status: 'running' | 'done' | 'error'; name?: string; detail?: string; error?: string; diff?: Diff }
  /** How many agents are working for the provider. */
  | { type: 'agents'; count: number }
  | { type: 'note'; text: string; tone?: 'dim' | 'error' }
  /** The turn is over; `failure` says why it didn't finish. */
  | { type: 'end'; failure?: string; cost?: string }
  /** The provider stopped working and needs restarting. */
  | { type: 'crash'; message: string }

export type Approval = { tool: string; detail: string; reason?: string; diff?: Diff; canAlways: boolean }

/** Milo's side: where a provider reports, and how it asks the user. */
export type Host = {
  emit: (event: ProviderEvent) => void
  /** Asks the user before an action; an abort answers no. */
  approve: (request: Approval, signal: AbortSignal) => Promise<Choice>
  /** Asks the user questions; undefined if the turn was stopped first. */
  ask: (questions: Question[], signal: AbortSignal) => Promise<Record<string, string> | undefined>
}

/** A prompt as each provider takes it: Claude Code reads content, Codex text and image paths. */
export type Prompt = { text: string; content: Content; images: string[] }

export type StartOptions = { resume?: string; mode?: PermissionMode; model?: string }

export interface Provider {
  readonly id: ProviderId
  /** The name the user sees, as in "Back to Claude Code." */
  readonly label: string
  /** Starts a turn; it ends with an 'end' event. */
  send: (prompt: Prompt) => void
  /** Asks the turn in progress to stop; rejects if the provider can't. */
  interrupt: () => Promise<void>
  setMode: (mode: PermissionMode) => Promise<void>
  setModel: (name: string) => Promise<void>
  /** Reports the header numbers again. */
  refresh: () => void
  /** Stops everything; no more events follow. */
  close: () => void
}

// --- Shared by providers ---------------------------------------------------

export const clip = (text: string, max = 90) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The one-line detail shown beside a tool call. */
export const summarize = (input: Record<string, unknown>): string => {
  const key = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'].find(
    k => typeof input[k] === 'string',
  )
  return key ? clip(String(input[key])) : ''
}
