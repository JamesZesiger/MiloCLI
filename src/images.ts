// Images in a prompt: paths to image files (typed, dragged into the terminal,
// or saved from the clipboard) go to Claude as pictures alongside the text.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export type Content = SDKUserMessage['message']['content']

const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
} as const

// The API turns away images over 5 MB once base64 encoded.
const MAX_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4)

const isWsl = !!process.env.WSL_DISTRO_NAME || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')

/** A path as typed or dropped in: quotes, file:// URLs, ~, and Windows drives under WSL. */
const toPath = (word: string) => {
  let path = word.replace(/^file:\/\//, '')
  try {
    if (word.startsWith('file://')) path = decodeURIComponent(path)
  } catch {
    // Not a valid URL escape: use it as typed.
  }
  const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(path)
  if (drive && isWsl) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll('\\', '/')}`
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
  return resolve(path.replace(/\\ /g, ' '))
}

// Quoted paths, or runs of non-spaces where a backslash can escape a space.
const WORDS = /'([^']+)'|"([^"]+)"|((?:\\ |\S)+)/g

export type Prompt = { content: Content; images: string[]; problems: string[] }

/** The prompt to send: the text, plus any image files it names. */
export const withImages = (text: string): Prompt => {
  const images: string[] = []
  const problems: string[] = []
  const blocks: Exclude<Content, string> = []
  const seen = new Set<string>()
  for (const [, single, double, bare] of text.matchAll(WORDS)) {
    const word = (single ?? double ?? bare!).replace(/[.,;:!?)]+$/, '')
    const type = TYPES[extname(word).toLowerCase() as keyof typeof TYPES]
    if (!type) continue
    const path = toPath(word)
    if (seen.has(path) || !existsSync(path)) continue
    seen.add(path)
    try {
      if (statSync(path).size > MAX_BYTES) {
        problems.push(`${basename(path)} is over 5 MB, so it wasn't attached.`)
        continue
      }
      blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data: readFileSync(path).toString('base64') } })
      images.push(path)
    } catch (err) {
      problems.push(`Couldn't read ${basename(path)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { content: blocks.length ? [...blocks, { type: 'text', text }] : text, images, problems }
}

/** The image file a paste names, when it's nothing but one path to an image, as a file dragged in is. */
export const imageFile = (text: string): string | undefined => {
  const words = [...text.trim().matchAll(WORDS)]
  if (words.length !== 1) return undefined
  const [, single, double, bare] = words[0]!
  const word = single ?? double ?? bare!
  if (!(extname(word).toLowerCase() in TYPES)) return undefined
  const path = toPath(word)
  return existsSync(path) ? path : undefined
}

// --- The clipboard ---------------------------------------------------------

const run = promisify(execFile)

/** Writes the clipboard's image to `file` as a PNG; false when there is none. */
const saveClipboard = async (file: string): Promise<boolean> => {
  if (isWsl || process.platform === 'win32') {
    const target = isWsl ? (await run('wslpath', ['-w', file])).stdout.trim() : file
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
      '$image = [System.Windows.Forms.Clipboard]::GetImage()',
      `if ($image) { $image.Save('${target.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png) }`,
    ].join('; ')
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script])
  } else if (process.platform === 'darwin') {
    await run('osascript', [
      '-e', `set out to open for access POSIX file "${file}" with write permission`,
      '-e', 'write (the clipboard as «class PNGf») to out',
      '-e', 'close access out',
    ]).catch(() => undefined)
  } else {
    const tools: [string, string[]][] = [
      ['wl-paste', ['--no-newline', '--type', 'image/png']],
      ['xclip', ['-selection', 'clipboard', '-target', 'image/png', '-out']],
    ]
    for (const [tool, args] of tools) {
      const image = await run(tool, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).catch(() => undefined)
      if (image?.stdout.length) {
        writeFileSync(file, image.stdout)
        break
      }
    }
  }
  return existsSync(file) && statSync(file).size > 0
}

// Pasted images only need to last until Milo exits.
const pasted = new Set<string>()
const removePasted = () => pasted.forEach(file => rmSync(file, { force: true }))

/** Saves the clipboard's image to a temporary PNG and returns its path, if there is one. */
export const pasteImage = async (): Promise<string | undefined> => {
  const file = join(tmpdir(), `milo-paste-${Date.now()}.png`)
  try {
    if (await saveClipboard(file)) {
      if (!pasted.size) process.once('exit', removePasted)
      pasted.add(file)
      return file
    }
  } catch {
    // No clipboard tool here, or it failed: treat as no image.
  }
  rmSync(file, { force: true })
  return undefined
}
