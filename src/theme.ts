// Color themes: the job each of Milo's colors does, and the shade each theme
// gives it. Bold, dim and inverse stay the same in every theme.

export type Role = 'accent' | 'focus' | 'ok' | 'error'

/**
 * A basic terminal color, which follows the terminal's own palette, or a hex
 * color. Basic names are the ones Ink knows too, so borders can use them.
 */
export type Shade = 'yellow' | 'cyan' | 'green' | 'red' | 'blue' | 'magenta' | `#${string}`

export type Theme = { about: string; colors: Record<Role, Shade> }

export const THEMES = {
  milo: { about: "the terminal's own colors", colors: { accent: 'yellow', focus: 'cyan', ok: 'green', error: 'red' } },
  tabby: { about: 'ginger and gold', colors: { accent: '#ff8c42', focus: '#ffc857', ok: '#9bc53d', error: '#e55934' } },
  ocean: { about: 'blues and teal', colors: { accent: '#4cc9f0', focus: '#7b9cff', ok: '#2ec4b6', error: '#ff6b6b' } },
  forest: { about: 'moss and amber', colors: { accent: '#8fbf5a', focus: '#e0c068', ok: '#56d6a0', error: '#e06c75' } },
  violet: { about: 'purple and periwinkle', colors: { accent: '#c792ea', focus: '#82aaff', ok: '#c3e88d', error: '#ff5370' } },
  light: { about: 'darker shades for light backgrounds', colors: { accent: '#c25e00', focus: '#005f87', ok: '#2e7d32', error: '#c62828' } },
} satisfies Record<string, Theme>

export type ThemeName = keyof typeof THEMES
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[]

/** Matches a theme name in any case. */
export const findTheme = (name: string) => THEME_NAMES.find(t => t === name.trim().toLowerCase())

let current: ThemeName = 'milo'

export const themeName = () => current
export const setTheme = (name: ThemeName) => {
  current = name
}

/** The shade the current theme gives a role, as Ink takes it for borders. */
export const shade = (role: Role): Shade => THEMES[current].colors[role]

export const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? '') || !!process.env.WT_SESSION

export type RGB = [number, number, number]

/** The nearest color in the 256-color cube, for terminals without truecolor. */
export const to256 = ([r, g, b]: RGB) => {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40))
  return 16 + 36 * level(r) + 6 * level(g) + level(b)
}

const BASIC: Record<string, number> = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 }

/** The escape code's parameters that set text to a shade. */
export const sgr = (color: Shade) => {
  if (!color.startsWith('#')) return String(BASIC[color])
  const n = parseInt(color.slice(1), 16)
  const rgb: RGB = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return truecolor ? `38;2;${rgb.join(';')}` : `38;5;${to256(rgb)}`
}
