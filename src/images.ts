// Attachments in a prompt: paths to image files (typed, dragged into the
// terminal, or saved from the clipboard) go to Claude as pictures alongside
// the text, videos go as a few frames taken with ffmpeg, and files mentioned
// as @path go with their contents.
import { execFile, execFileSync } from 'node:child_process'
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

// Claude can't watch video, so these go as frames.
const VIDEOS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'])
// About one frame a second, up to this many, spread over the clip.
const MAX_FRAMES = 8

/** True for a path to a video file, by its extension. */
export const isVideo = (path: string) => VIDEOS.has(extname(path).toLowerCase())

// The API turns away images over 5 MB once base64 encoded.
const MAX_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4)
// A mentioned file bigger than this is left for Claude to read in parts.
const MAX_MENTION_BYTES = 256 * 1024

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

export type Prompt = { content: Content; images: string[]; videos: string[]; frames: string[]; files: string[]; problems: string[] }

/** A file mentioned as @path, as text to send with the prompt; undefined for folders and missing files. */
const mention = (word: string, path: string, problems: string[]) => {
  try {
    const info = statSync(path)
    if (!info.isFile()) return undefined
    if (info.size > MAX_MENTION_BYTES) {
      problems.push(`${basename(path)} is over 256 KB, so Claude gets its name and reads it as needed.`)
      return undefined
    }
    const text = readFileSync(path, 'utf8')
    if (text.includes('\0')) {
      problems.push(`${basename(path)} looks like a binary file, so it wasn't attached.`)
      return undefined
    }
    return `Contents of ${word}:\n\n${text}`
  } catch {
    return undefined
  }
}

// Frames and pasted images only need to last until Milo exits.
const temporary = new Set<string>()
const removeTemporary = () => temporary.forEach(file => rmSync(file, { force: true }))
const keep = (file: string) => {
  if (!temporary.size) process.once('exit', removeTemporary)
  temporary.add(file)
}

/** Frames spread over a video, as JPEGs, with the second each comes from; undefined without ffmpeg. */
const videoFrames = (path: string, problems: string[]) => {
  const ffmpeg = (tool: string, args: string[]) => execFileSync(tool, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  let duration: number
  try {
    duration = Number(ffmpeg('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]))
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    problems.push(missing ? `Sending ${basename(path)} needs ffmpeg installed, so it wasn't attached.` : `Couldn't read ${basename(path)} as a video.`)
    return undefined
  }
  // Some files don't say how long they are: take the first frame.
  const count = Number.isFinite(duration) && duration > 0 ? Math.min(MAX_FRAMES, Math.ceil(duration)) : 1
  const frames: { file: string; at: number }[] = []
  for (let i = 0; i < count; i++) {
    const at = duration > 0 ? (duration * (i + 0.5)) / count : 0
    const file = join(tmpdir(), `milo-frame-${Date.now()}-${i}.jpg`)
    try {
      ffmpeg('ffmpeg', ['-v', 'error', '-ss', at.toFixed(2), '-i', path, '-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", '-q:v', '4', '-y', file])
    } catch {
      // Past the last frame, or a bad spot in the file: skip it.
    }
    if (!existsSync(file)) continue
    keep(file)
    frames.push({ file, at })
  }
  if (!frames.length) problems.push(`Couldn't take any frames from ${basename(path)}.`)
  return frames
}

/** The prompt to send: the text, plus any image and video files it names and files it mentions as @path. */
export const withAttachments = (text: string): Prompt => {
  const images: string[] = []
  const videos: string[] = []
  const frames: string[] = []
  const files: string[] = []
  const problems: string[] = []
  const blocks: Exclude<Content, string> = []
  const seen = new Set<string>()
  for (const [, single, double, bare] of text.matchAll(WORDS)) {
    const raw = (single ?? double ?? bare!).replace(/[.,;:!?)]+$/, '')
    const mentioned = raw.startsWith('@') && raw.length > 1
    const word = mentioned ? raw.slice(1) : raw
    const type = TYPES[extname(word).toLowerCase() as keyof typeof TYPES]
    const video = isVideo(word)
    if (!type && !video && !mentioned) continue
    const path = toPath(word)
    if (seen.has(path) || !existsSync(path)) continue
    seen.add(path)
    if (video) {
      const taken = videoFrames(path, problems)
      if (!taken?.length) continue
      const times = taken.map(frame => `${frame.at.toFixed(1)}s`).join(', ')
      blocks.push({ type: 'text', text: `Frames from the video ${word}, at ${times}:` })
      for (const frame of taken)
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(frame.file).toString('base64') } })
      frames.push(...taken.map(frame => frame.file))
      videos.push(path)
      continue
    }
    if (!type) {
      const contents = mention(raw, path, problems)
      if (contents === undefined) continue
      blocks.push({ type: 'text', text: contents })
      files.push(path)
      continue
    }
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
  return { content: blocks.length ? [...blocks, { type: 'text', text }] : text, images, videos, frames, files, problems }
}

/** The image or video file a paste names, when it's nothing but one path to one, as a file dragged in is. */
export const imageFile = (text: string): string | undefined => {
  const words = [...text.trim().matchAll(WORDS)]
  if (words.length !== 1) return undefined
  const [, single, double, bare] = words[0]!
  const word = single ?? double ?? bare!
  if (!(extname(word).toLowerCase() in TYPES) && !isVideo(word)) return undefined
  const path = toPath(word)
  return existsSync(path) ? path : undefined
}

// --- The clipboard ---------------------------------------------------------

const run = promisify(execFile)

/** True for a path Milo sends as a picture or as frames. */
const isMedia = (path: string) => extname(path).toLowerCase() in TYPES || isVideo(path)

/** The first of the clipboard tools here that has something of `type`, as a buffer. */
const linuxClipboard = async (type: string) => {
  const tools: [string, string[]][] = [
    ['wl-paste', ['--no-newline', '--type', type]],
    ['xclip', ['-selection', 'clipboard', '-target', type, '-out']],
  ]
  for (const [tool, args] of tools) {
    const out = await run(tool, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).catch(() => undefined)
    if (out?.stdout.length) return out.stdout
  }
  return undefined
}

/**
 * The image and video files copied to the clipboard, as from a file manager;
 * failing that, the clipboard's picture written to `file` as a PNG.
 */
const readClipboard = async (file: string): Promise<string[]> => {
  let copied: string[] = []
  if (isWsl || process.platform === 'win32') {
    // One PowerShell for both, since each start takes a moment.
    const target = isWsl ? (await run('wslpath', ['-w', file])).stdout.trim() : file
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$files = [System.Windows.Forms.Clipboard]::GetFileDropList()',
      '$image = if ($files.Count) { $null } else { [System.Windows.Forms.Clipboard]::GetImage() }',
      `if ($image) { $image.Save('${target.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png) } else { $files }`,
    ].join('; ')
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script])
    const windows = stdout.split(/\r?\n/).filter(path => path && isMedia(path))
    copied = isWsl ? await Promise.all(windows.map(async path => (await run('wslpath', ['-u', path])).stdout.trim())) : windows
  } else if (process.platform === 'darwin') {
    const { stdout = '' } = (await run('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)']).catch(() => undefined)) ?? {}
    copied = stdout.trim() ? [stdout.trim()] : []
    if (!copied.length)
      await run('osascript', [
        '-e', `set out to open for access POSIX file "${file}" with write permission`,
        '-e', 'write (the clipboard as «class PNGf») to out',
        '-e', 'close access out',
      ]).catch(() => undefined)
  } else {
    const uris = (await linuxClipboard('text/uri-list'))?.toString('utf8') ?? ''
    copied = uris.split(/\r?\n/).filter(uri => uri.startsWith('file://')).map(toPath)
    const image = copied.length ? undefined : await linuxClipboard('image/png')
    if (image) writeFileSync(file, image)
  }
  copied = copied.filter(path => isMedia(path) && existsSync(path))
  if (copied.length) return copied
  return existsSync(file) && statSync(file).size > 0 ? [file] : []
}

/** The image and video files on the clipboard, or its picture saved to a temporary PNG; empty when there's neither. */
export const pasteMedia = async (): Promise<string[]> => {
  const file = join(tmpdir(), `milo-paste-${Date.now()}.png`)
  try {
    const found = await readClipboard(file)
    if (found.includes(file)) keep(file)
    else rmSync(file, { force: true })
    return found
  } catch {
    // No clipboard tool here, or it failed: treat as nothing to paste.
  }
  rmSync(file, { force: true })
  return []
}
