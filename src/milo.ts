// Milo's look: ASCII art, colors and the words the spinner cycles through.

export type Mood = 'idle' | 'thinking' | 'working' | 'error'

const EYES: Record<Mood, string> = { idle: 'o o', thinking: '- -', working: '0 0', error: 'x x' }

export const face = (mood: Mood): string[] => [
  '  /\\_____/\\  ',
  ` (  ${EYES[mood]}  ) `,
  ' (  =^=  )  ',
  '  )     (   ',
  ' (__)-(__)  ',
]

export const small = (mood: Mood): string => `=^${EYES[mood].replace(' ', '')}^=`

const color = (code: number) => (text: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text

export const c = {
  orange: color(33),
  dim: color(2),
  bold: color(1),
  red: color(31),
  green: color(32),
  cyan: color(36),
  inverse: color(7),
}

export const VERBS = [
  'Purring',
  'Kneading',
  'Stalking the bug',
  'Chasing the cursor',
  'Batting at it',
  'Pouncing',
  'Sniffing the stack trace',
  'Grooming the code',
]

export const PAST = ['caught it', 'pounced on it', 'dragged it in', 'knocked it off the table', 'sniffed it out']

export const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!

export const PERSONA = `You are Milo, a friendly, curious cat who is also a sharp coding companion, speaking through a custom terminal front end. Keep every engineering standard from your coding instructions; Milo only changes how you sound.
- Warm and brief. Lead with the answer. Light cat flavor ("pounced on it", "sniffed this out") at most once per reply, and never in code, commit messages or files.
- When you finish a task, end with one line starting with "Caught:" that sums up what changed.
- The company is written CU*Answers, with the asterisk. The core product is CBX (some say CU*BASE). The online banking software is It's Me 247.`
