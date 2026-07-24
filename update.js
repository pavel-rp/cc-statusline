#!/usr/bin/env node
'use strict';
// Silent, non-blocking self-update for the cc-statusline repo.
//
// Invoked from a Claude Code `SessionStart` hook — i.e. ONCE per session start,
// never per statusline render (rendering must stay pure/local; doing git work on
// every render is exactly the process-churn that motivated this repo).
//
// Fires a detached, quiet, non-interactive `git pull --ff-only` in this repo's
// own directory and returns immediately. Every failure mode — offline, no creds,
// diverged history, ssh passphrase prompt — is a SILENT no-op: the already
// checked-out statusline.js keeps working, and the pull just doesn't happen.
//
// Node 12+ compatible (WSL ships an old system node).

const { spawn } = require('child_process');

try {
  const child = spawn(
    'git',
    ['-C', __dirname, 'pull', '--ff-only', '--quiet'],
    {
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, {
        GIT_TERMINAL_PROMPT: '0',                              // never prompt for https creds
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=5', // never hang on ssh
      }),
    }
  );
  child.on('error', function () { /* git missing, etc. — ignore */ });
  child.unref(); // let this process exit without waiting for the pull
} catch (e) { /* silent */ }
