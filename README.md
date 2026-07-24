# cc-statusline

A single, portable [Claude Code](https://claude.com/claude-code) status line —
one zero-subprocess Node script shared across Windows, WSL, and a Docker sandbox.

Two lines, an *instrument panel*:

```
 second-memory    chore/track-durable-research-docs   Opus · high ⇢ 2× Sonnet 5
▓▓▓▓▓▓░░░ 72%   1.2M   $3.40   5h ◔ 24%  7d ◑ 41%   +156/-23
```

- **Line 1** — folder · git branch · model · effort · **live subagent model(s)**
- **Line 2** — a context gauge that shifts **green → amber → red** as the window
  fills, cumulative session tokens (**main loop + every subagent**), cost, 5h/7d
  rate-limit dot-meters (`◔◑◕●`, colored by fill), and lines changed.

Every field degrades gracefully — absent input fields are simply omitted.

## Subagent models (`⇢`)

Claude's status JSON is session-level: its `model` is always the **main loop's**,
even while a Sonnet or Haiku subagent is doing the work. The `⇢` field is derived
instead from the subagent transcripts Claude Code writes per session:

```
<project>/<sessionId>/subagents/agent-<id>.jsonl      # assistant lines carry message.model
<project>/<sessionId>/subagents/agent-<id>.meta.json  # {agentType, toolUseId, spawnDepth}
```

An agent is *live* when its transcript was appended to in the last 10s — which
covers background agents, whose `tool_result` returns immediately — or when the
`Task`/`Agent` `tool_use` that spawned it still has no `tool_result` (capped at
10 min, so an interrupted agent can't pin a phantom on the line). That second
signal keeps a foreground agent on screen while it sits inside a slow tool call.

Concurrent agents collapse by model: `Sonnet 5`, `2× Sonnet 5`, `Sonnet 5, Haiku 4.5`.

Those same transcripts are what makes the **token count whole**. Claude Code no
longer folds subagent usage into the main transcript, so a status line reading
only `<sessionId>.jsonl` silently undercounts every fan-out — in one session here
a Haiku fan-out was 29% of the total burn. Each transcript is scanned
incrementally (cached byte offset + running total + last-seen model, keyed by
session), so a render parses only the bytes appended since the previous one, and
a finished agent costs one `stat()` forever after. Lines are pre-filtered by
substring before `JSON.parse`, which keeps even a cold cache cheap: ~13 MB of
transcripts parses in ~70 ms.

Note this only refreshes as often as Claude Code re-renders the status line — the
field is as live as the rest of the panel, not more.

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
