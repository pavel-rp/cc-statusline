# cc-statusline

A single, portable [Claude Code](https://claude.com/claude-code) status line —
one zero-subprocess Node script shared across Windows, WSL, and a Docker sandbox.

Two lines, an *instrument panel*:

```
 second-memory    chore/track-durable-research-docs   Opus · high
▓▓▓▓▓▓░░░ 72%   1.2M   $3.40   5h ◔ 24%  7d ◑ 41%   +156/-23
```

- **Line 1** — folder · git branch · model · effort
- **Line 2** — a context gauge that shifts **green → amber → red** as the window
  fills, cumulative session tokens, cost, 5h/7d rate-limit dot-meters
  (`◔◑◕●`, colored by fill), and lines changed.

Every field degrades gracefully — absent input fields are simply omitted.

## Why a repo

The predecessor shelled out to `bash`/`jq`/`git` on **every render**, and with
several concurrent Claude sessions that process-creation churn showed up as
sustained kernel/privileged CPU. `statusline.js` spawns **nothing**: the git
branch is read straight from `.git/HEAD`, truecolor is emitted inline.

## Files

| File | Role |
|------|------|
| `statusline.js` | The renderer. Reads Claude's status JSON on stdin, prints two ANSI lines. |
| `update.js` | Silent, non-blocking `git pull --ff-only`, fired from a `SessionStart` hook. |

## Install (per environment)

Clone, then point that environment's `~/.claude/settings.json` at the clone:

```jsonc
{
  "statusLine": {
    "type": "command",
    "command": "node <clone>/statusline.js"
  },
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node <clone>/update.js" } ] }
    ]
  }
}
```

The `SessionStart` hook runs once per session start (not per render), so each
new session silently pulls the latest script. Offline or unauthenticated → it's
a no-op and the checked-out copy keeps working.

## Requirements

- Node 12+ (kept deliberately old-node-safe).
- A terminal with truecolor + a Nerd Font fallback for the branch/folder glyphs
  (WezTerm ships one by default).
