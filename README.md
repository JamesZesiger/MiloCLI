# Milo

Milo is a cat-themed terminal front end for Claude Code. Claude Code runs in the
background through the Claude Agent SDK, and Milo gives it a full-screen home:
a chat workspace, a file explorer, a code editor and a command line, with a cat
who reacts as Claude thinks and works.

## Requirements

- Node.js 20 or later
- Claude Code signed in on this machine (or `ANTHROPIC_API_KEY` set). Milo uses
  the same account, settings, skills and subagents as Claude Code.

## Getting started

```sh
npm install
npm start          # build, then run Milo
```

To run `milo` from any folder:

```sh
npm run build
npm link
milo
```

Milo works in the folder you start it from. In a terminal it runs full screen;
when piped, or with `--plain`, it runs line by line.

| Script              | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm start`         | Build and run                                   |
| `npm run dev`       | Run from source with `tsx`, no build step       |
| `npm run build`     | Typecheck and bundle to `dist/milo.js`          |
| `npm run typecheck` | Typecheck only                                  |
| `npm run frame`     | Print one frame of the app with sample content; pass `-- [columns] [rows] [character]` to set the size and mascot |

## Talking to Milo

Type a prompt and press Enter. Messages sent while Claude is busy wait their
turn. Image files named in a prompt, typed or dragged in, are sent as pictures,
and Ctrl+V or Alt+V pastes an image from the clipboard.

While Claude works, an orange streak circles the workspace border. When Claude
is waiting on you to approve something or answer a question, the whole border
lights up.

When Claude wants to run a tool or edit a file, Milo asks first and shows the
change side by side. Shift+Tab cycles the permission mode: Default, Accept
edits, Plan and Auto.

### Commands

| Command          | What it does                                                   |
| ---------------- | -------------------------------------------------------------- |
| `/help`          | Show commands and keys                                         |
| `/commands`      | List every Claude Code command and skill you can use           |
| `/resume [n]`    | List recent conversations in this folder, or pick one up       |
| `/continue`      | Pick up the most recent conversation in this folder            |
| `/status`        | Show the folder, session, model, mode and account              |
| `/mode [name]`   | Show or switch the permission mode                             |
| `/agents`        | List the subagents Claude can use                              |
| `/milo [size]`   | Show the mascot: `small` or `big`, or `thinking`, `working`, `error` |
| `/char [name]`   | List the mascots, or switch to one: `milo`, `boo` or `none`    |
| `/diff`          | Show or hide the last file change                              |
| `/copy [n]`      | Copy the last reply, or the nth from last, to the clipboard    |
| `/settings`      | Show Milo's settings, or save one                              |
| `/theme [name]`  | List the color themes, or switch to one                        |
| `/new`           | Start a fresh conversation                                     |
| `/exit`          | Leave                                                          |

Anything else, including Claude Code commands like `/model`, `/context`,
`/compact` and `/usage`, goes straight to Claude.

### Keys

| Key            | What it does                                                    |
| -------------- | --------------------------------------------------------------- |
| Tab            | Finish the command you're typing                                |
| PgUp / PgDn    | Scroll the workspace or the diff (the mouse wheel works too)    |
| Ctrl+O         | Show or hide the last file change                               |
| Ctrl+B         | Show or hide the file explorer                                  |
| Drag           | Select text in the workspace; letting go copies it              |
| Esc            | Stop a reply, or close the diff                                 |
| Ctrl+C         | Stop a reply (twice forces it), clear the input, or leave (twice) |

## File explorer, editor and command line

Ctrl+B opens the explorer beside the workspace, and the input box becomes a
command line.

- **Explorer:** arrow keys or letters to move, → and ← to open and close
  folders, Enter or a click to open a file.
- **Editor:** Ctrl+S saves, Ctrl+W closes, Ctrl+Z and Ctrl+Y undo and redo.
  An open file reloads when Claude changes it, unless it has unsaved changes.
- **Command line:** commands run in your shell, with output in the terminal
  pane. Tab completes commands and paths, ↑ and ↓ go through earlier commands,
  and Ctrl+C stops a running command.

A plain `cd` moves the explorer and Claude Code to the new folder, keeping the
same conversation. If Claude is mid-reply, the move happens when the reply ends.

Esc steps back from the editor to the explorer to the command line. Ctrl+B
closes them and goes back to talking to Milo.

## Settings

Milo's own settings live in `~/.milo/settings.toml`, one `key = "value"` per
line. Claude Code's settings stay in `~/.claude`.

| Setting        | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `default_mode` | The permission mode Milo starts in: Default, Accept edits, Plan or Auto |
| `theme`        | Milo's colors: milo, tabby, ocean, forest, violet or light   |
| `character`    | The mascot and its personality: milo, boo or none            |

Set one from inside Milo with `/settings default_mode Auto`.

### Themes

`/theme` lists the color themes with a sample of each, and `/theme ocean`
switches to one at once and saves it for next time. The `milo` theme uses your
terminal's own colors; the others use fixed shades, and `light` suits
light-background terminals. Themes live in `src/theme.ts`, each giving a shade
to the four colors Milo uses: accent, focus, ok and error.

### Characters

The mascot in the header, and the personality Claude speaks with, is a
character. `/char` lists them and `/char boo` switches at once and saves it for
next time.

| Character | Who                                                              |
| --------- | ---------------------------------------------------------------- |
| `milo`    | The default: an orange and white cat, warm and brief             |
| `boo`     | A tortoiseshell with tortitude: dry, confident, a little sassy   |
| `none`    | No mascot and no added personality: Claude's own voice           |

A new personality means restarting Claude Code, which Milo does on the same
conversation, waiting for any reply in progress to finish. Characters live in
`src/characters.ts`, and each cat's coat in `src/portrait.ts`.

## Project layout

```
src/
  index.ts      entry point: full screen or plain mode
  tui.tsx       the full-screen app (Ink)
  plain.ts      line-by-line mode
  session.ts    the background Claude Code session
  commands.ts   Milo's slash commands
  explorer.ts   the file tree
  editor.ts     the code editor
  terminal.ts   the command line: running commands, cd and completion
  images.ts     images in prompts and from the clipboard
  settings.ts   ~/.milo/settings.toml
  theme.ts      the color themes
  milo.ts       colors and moods
  characters.ts the mascots: names, faces, words and personalities
  portrait.ts   the mascot's portrait
build/
  bundle.mjs    bundles the app into dist/milo.js with esbuild
```

Built by CU*Answers.
