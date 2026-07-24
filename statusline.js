#!/usr/bin/env node
'use strict';
// Claude Code status line — "Instrument panel" (two-line gauge cluster).
//
// Design goals:
//   * ZERO subprocesses. The old bash version forked bash->bash->bash->node
//     plus two `git` calls plus a conhost per shell on every render; with
//     several concurrent Claude sessions that process-creation churn showed up
//     as sustained kernel/privileged CPU. This is one node process: git branch
//     is read straight from .git/HEAD, nothing is spawned.
//   * Truecolor (24-bit) — WezTerm renders it, and its bundled Nerd Font
//     fallback covers the powerline/git glyphs used below.
//
// Line 1:  <dir>   <branch>   <Model> · <effort>
// Line 2:  <ctx bar> %   <session tokens>   $<cost>   5h <meter>%  7d <meter>%   +added/-removed
//
// Every field degrades gracefully — absent input JSON fields are simply omitted.

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- read + parse stdin ----------
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { raw = ''; }
let d = {};
try { d = JSON.parse(raw); } catch (e) { d = {}; }

// ---------- truecolor helpers ----------
const RESET = '\x1b[0m';
const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;

const C = {
  dir:    fg(229, 192, 123), // amber
  branch: fg(86, 182, 194),  // teal
  model:  fg(198, 120, 221), // violet
  tokens: fg(127, 132, 142), // grey
  cost:   fg(152, 195, 121), // green
  add:    fg(152, 195, 121), // green
  rem:    fg(224, 108, 117), // red
  sep:    fg(92, 99, 112),   // dim separator
  muted:  fg(127, 132, 142), // dim label
};

// gauge/heat color by percent USED (green -> amber -> red)
function heat(pct) {
  if (pct == null) return C.muted;
  if (pct < 50) return fg(152, 195, 121); // green
  if (pct < 80) return fg(229, 192, 123); // amber
  return fg(224, 108, 117);               // red
}

// ---------- fields ----------
const cwd = d.cwd || (d.workspace && d.workspace.current_dir) || '';
const model = (d.model && d.model.display_name) || '';
const effort = d.effort && d.effort.level ? String(d.effort.level) : '';
const cw = d.context_window || {};
const usedPct = cw.used_percentage != null ? Math.round(cw.used_percentage) : null;
const cost = d.cost && typeof d.cost.total_cost_usd === 'number' ? d.cost.total_cost_usd : null;
const added = d.cost && typeof d.cost.total_lines_added === 'number' ? d.cost.total_lines_added : null;
const removed = d.cost && typeof d.cost.total_lines_removed === 'number' ? d.cost.total_lines_removed : null;
const rl = d.rate_limits || {};
const rl5 = rl.five_hour && rl.five_hour.used_percentage != null ? rl.five_hour.used_percentage : null;
const rl7 = rl.seven_day && rl.seven_day.used_percentage != null ? rl.seven_day.used_percentage : null;
const sessionId = d.session_id || 'default';
const transcriptPath = d.transcript_path || '';

// ---------- git branch WITHOUT spawning git ----------
// Walk up for a .git dir OR a .git file (worktree/submodule redirect), then
// parse HEAD: `ref: refs/heads/<branch>` -> branch, else detached -> short sha.
function readBranch(startDir) {
  try {
    if (!startDir) return '';
    let dir = startDir;
    let gitPath = null;
    for (let i = 0; i < 40; i++) {
      const p = path.join(dir, '.git');
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) { gitPath = p; break; }
        if (st.isFile()) {
          const txt = fs.readFileSync(p, 'utf8');
          const m = txt.match(/gitdir:\s*(.+)/);
          if (m) {
            let g = m[1].trim();
            if (!path.isAbsolute(g)) g = path.resolve(dir, g);
            gitPath = g;
            break;
          }
        }
      } catch (e) { /* no .git here, keep walking */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!gitPath) return '';
    const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
    const rm = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (rm) return rm[1];
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);
    return '';
  } catch (e) { return ''; }
}
const branch = readBranch(cwd);

// ---------- cumulative session tokens (incremental transcript parse) ----------
// Caches a byte offset + running totals per session so each render only reads
// the bytes appended since last time. Includes subagent/Task usage (same file).
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
let totalTokens = 0;
try {
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const cachedir = path.join(os.tmpdir(), 'claude-statusline-cache');
    try { fs.mkdirSync(cachedir, { recursive: true }); } catch (e) {}
    const cacheFile = path.join(cachedir, 'tokens-' + sessionId + '.json');
    const stat = fs.statSync(transcriptPath);
    let totals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    let offset = 0, remainder = '';
    let cache = null;
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) { cache = null; }
    if (cache && typeof cache.offset === 'number' && cache.offset <= stat.size) {
      totals = cache.totals || totals;
      offset = cache.offset;
      remainder = cache.remainder || '';
    }
    if (offset < stat.size) {
      const fd = fs.openSync(transcriptPath, 'r');
      const len = stat.size - offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      fs.closeSync(fd);
      const chunk = remainder + buf.toString('utf8');
      const lastNl = chunk.lastIndexOf('\n');
      let toParse = '', newRem = chunk;
      if (lastNl !== -1) { toParse = chunk.slice(0, lastNl); newRem = chunk.slice(lastNl + 1); }
      for (const line of toParse.split('\n')) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        const u = obj && obj.message && obj.message.usage;
        if (u) {
          totals.input += u.input_tokens || 0;
          totals.output += u.output_tokens || 0;
          totals.cacheCreate += u.cache_creation_input_tokens || 0;
          totals.cacheRead += u.cache_read_input_tokens || 0;
        }
      }
      try {
        fs.writeFileSync(cacheFile, JSON.stringify({ offset: stat.size - newRem.length, totals, remainder: newRem }));
      } catch (e) {}
    }
    totalTokens = totals.input + totals.output + totals.cacheCreate + totals.cacheRead;
  }
} catch (e) { totalTokens = 0; }

// ---------- gauges ----------
function bar(pct, width) {
  width = width || 9;
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled); // ▓ / ░
}
function dot(pct) {
  if (pct == null) return '○';      // ○
  if (pct < 13) return '○';         // ○
  if (pct < 38) return '◔';         // ◔
  if (pct < 63) return '◑';         // ◑
  if (pct < 88) return '◕';         // ◕
  return '●';                        // ●
}

// ---------- icons (Nerd Font fallback) ----------
const ICON_DIR = '';    // nf-fa-folder
const ICON_BRANCH = ''; // nf-pl-branch

// ---------- compose ----------
const dirName = cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : '';

// line 1: context (where am I / what am I)
const l1 = [];
if (dirName) l1.push(`${C.dir}${ICON_DIR} ${dirName}${RESET}`);
if (branch) l1.push(`${C.branch}${ICON_BRANCH} ${branch}${RESET}`);
let ms = '';
if (model) ms += `${C.model}${model}${RESET}`;
if (effort) ms += `${C.sep} · ${RESET}${C.muted}${effort}${RESET}`;
if (ms) l1.push(ms);
const line1 = l1.join('   ');

// line 2: gauges (how much have I burned)
const l2 = [];
if (usedPct != null) l2.push(`${heat(usedPct)}${bar(usedPct)}${RESET} ${heat(usedPct)}${usedPct}%${RESET}`);
if (totalTokens > 0) l2.push(`${C.tokens}${fmtTokens(totalTokens)}${RESET}`);
if (cost != null) l2.push(`${C.cost}$${cost.toFixed(2)}${RESET}`);
if (rl5 != null) l2.push(`${C.muted}5h${RESET} ${heat(rl5)}${dot(rl5)} ${Math.round(rl5)}%${RESET}`);
if (rl7 != null) l2.push(`${C.muted}7d${RESET} ${heat(rl7)}${dot(rl7)} ${Math.round(rl7)}%${RESET}`);
if (added != null || removed != null) {
  l2.push(`${C.add}+${added || 0}${RESET}${C.sep}/${RESET}${C.rem}-${removed || 0}${RESET}`);
}
const line2 = l2.join('   ');

let out = line1;
if (line2) out += '\n' + line2;
process.stdout.write(out + '\n');
