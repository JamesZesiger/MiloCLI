// Milo's colors and moods. Each mascot's faces and words live in characters.ts.
import { sgr, shade, type Role, type Shade } from './theme.js'

export type Mood = 'idle' | 'thinking' | 'working' | 'error'

const colorOn = () => process.stdout.isTTY && !process.env.NO_COLOR
const style = (code: string) => (text: string) => (colorOn() ? `\x1b[${code}m${text}\x1b[0m` : text)
// Each role takes its shade from the current theme as it paints, so a new theme shows at once.
const role = (name: Role) => (text: string) => style(sgr(shade(name)))(text)

/** Paints text in a shade, as /theme does to show a theme's colors. */
export const paint = (color: Shade, text: string) => style(sgr(color))(text)

export const c = {
  accent: role('accent'),
  focus: role('focus'),
  ok: role('ok'),
  error: role('error'),
  dim: style('2'),
  bold: style('1'),
  inverse: style('7'),
}

export const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!
