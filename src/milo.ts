// Milo's colors and moods. Each mascot's faces and words live in characters.ts.
import { sgr, shade, themeName, type Role, type Shade } from './theme.js'

export type Mood = 'idle' | 'thinking' | 'working' | 'error'

const colorOn = () => process.stdout.isTTY && !process.env.NO_COLOR
const style = (code: string) => (text: string) => (colorOn() ? `\x1b[${code}m${text}\x1b[0m` : text)
// Each role takes its shade from the current theme as it paints, so a new theme shows at once.
const role = (name: Role) => (text: string) => style(sgr(shade(name)))(text)

/** Paints text in a shade, as /theme does to show a theme's colors. */
export const paint = (color: Shade, text: string) => style(sgr(color))(text)

/**
 * Sets text on a lighter (or, in the light theme, darker) background, kept
 * through the resets of any colors inside it, as your prompts show in the log.
 */
const lift = (text: string) => {
  if (!colorOn()) return text
  const bg = `\x1b[48;5;${themeName() === 'light' ? 254 : 236}m`
  return `${bg}${text.replaceAll('\x1b[0m', `\x1b[0m${bg}`)}\x1b[0m`
}

export const c = {
  accent: role('accent'),
  focus: role('focus'),
  ok: role('ok'),
  error: role('error'),
  dim: style('2'),
  bold: style('1'),
  inverse: style('7'),
  lift,
}

export const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!
