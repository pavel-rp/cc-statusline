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
// Line 1:  <dir>   <branch>   <Model> · <effort> [⇢ <active subagent model(s)>]
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
  sub:    fg(97, 175, 239),  // blue — subagent model
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
// the bytes appended since last time. Counts the main loop only — subagents get
// their own transcripts under <session>/subagents/ (see below).
// The same pass tracks in-flight Task/Agent tool_use ids (recorded, then dropped
// when their tool_result lands) so a foreground subagent stays "live" even while
// it sits inside a long tool call and appends nothing.
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
let totalTokens = 0;
let pendingAgents = {}; // tool_use id -> 1, for Task/Agent calls without a result yet
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
      if (cache.pending && typeof cache.pending === 'object') pendingAgents = cache.pending;
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
        const msg = obj && obj.message;
        const u = msg && msg.usage;
        if (u) {
          totals.input += u.input_tokens || 0;
          totals.output += u.output_tokens || 0;
          totals.cacheCreate += u.cache_creation_input_tokens || 0;
          totals.cacheRead += u.cache_read_input_tokens || 0;
        }
        const content = msg && msg.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (!b || typeof b !== 'object') continue;
            if (b.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent') && b.id) pendingAgents[b.id] = 1;
            else if (b.type === 'tool_result' && b.tool_use_id) delete pendingAgents[b.tool_use_id];
          }
        }
      }
      try {
        fs.writeFileSync(cacheFile, JSON.stringify({
          offset: stat.size - newRem.length, totals, remainder: newRem, pending: pendingAgents,
        }));
      } catch (e) {}
    }
    totalTokens = totals.input + totals.output + totals.cacheCreate + totals.cacheRead;
  }
} catch (e) { totalTokens = 0; }

// ---------- active subagent model(s) ----------
// The status line hook is session-level: the input JSON's model is always the
// MAIN loop's, never the subagent's. But every subagent writes its own
// transcript next to the session's:
//   <project>/<sessionId>/subagents/agent-<id>.jsonl   (assistant lines carry message.model)
//   <project>/<sessionId>/subagents/agent-<id>.meta.json  {agentType, toolUseId, spawnDepth}
// An agent counts as live if its transcript was appended to in the last few
// seconds (covers background agents, whose tool_result returns immediately) or
// if the Task/Agent tool_use that spawned it has no tool_result yet (covers a
// foreground agent parked inside a slow tool call). Still zero subprocesses:
// one readdir, a stat per agent file, and a 64K tail read per live agent.
const FRESH_MS = 10000;
// A pending tool_use can outlive its agent (interrupt, crash, compaction never
// writes the tool_result), so cap how long that keeps an idle agent on screen.
const PENDING_MAX_MS = 600000;
const TAIL_BYTES = 65536;

function readTail(file, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const txt = buf.toString('utf8');
    return start > 0 ? txt.slice(txt.indexOf('\n') + 1) : txt;
  } finally { fs.closeSync(fd); }
}

// Last model this agent actually ran on — read backwards, newest line wins.
function lastModelOf(file, size) {
  let tail = '';
  try { tail = readTail(file, size); } catch (e) { return ''; }
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"model"') === -1) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    const m = obj && obj.type === 'assistant' && obj.message && obj.message.model;
    if (m && m !== '<synthetic>') return m;
  }
  return '';
}

function readMeta(jsonlFile) {
  try {
    return JSON.parse(fs.readFileSync(jsonlFile.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch (e) { return null; }
}

// claude-sonnet-5 -> Sonnet 5 · claude-haiku-4-5-20251001 -> Haiku 4.5
// claude-opus-5[1m] -> Opus 5 · claude-3-5-sonnet-20241022 -> Sonnet 3.5
// bare alias "haiku" -> Haiku (meta.json records the requested alias, not the
// resolved id). An unrecognized id passes through, but stripped of control
// characters and clipped — this string is interpolated straight into an ANSI
// line, so a stray \x1b or newline there would corrupt the panel.
function cap(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }
function modelLabel(id) {
  const s = String(id == null ? '' : id).replace(/[\x00-\x1f\x7f]/g, '');
  if (!s) return '';
  if (/^(opus|sonnet|haiku|fable)$/i.test(s)) return cap(s);
  const m = s.match(/^(?:[\w.]+\.)?claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?/i);
  if (m) return cap(m[1]) + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
  const legacy = s.match(/^(?:[\w.]+\.)?claude-(\d+)-(\d+)-(opus|sonnet|haiku)/i);
  if (legacy) return cap(legacy[3]) + ' ' + legacy[1] + '.' + legacy[2];
  return s.length > 20 ? s.slice(0, 19) + '…' : s;
}

function activeSubagentModels() {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const now = Date.now();
  const hasPending = Object.keys(pendingAgents).length > 0;
  const labels = [];
  for (const name of names) {
    if (!/^agent-.+\.jsonl$/.test(name)) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch (e) { continue; }
    const age = now - st.mtimeMs;
    const live = age < FRESH_MS;
    let meta = null;
    if (!live) {
      if (!hasPending || age >= PENDING_MAX_MS) continue;
      meta = readMeta(file);
      if (!(meta && meta.toolUseId && pendingAgents[meta.toolUseId])) continue;
    }
    // The transcript wins — it carries the resolved id (Haiku 4.5). meta.json's
    // alias only covers the window between spawn and the first assistant line,
    // when the transcript has no model in it yet.
    let label = modelLabel(lastModelOf(file, st.size));
    if (!label) label = modelLabel(meta ? meta.model : (meta = readMeta(file)) && meta.model);
    if (label) labels.push(label);
  }
  return labels;
}

// Collapse to "Sonnet 5" / "2× Sonnet 5" / "Sonnet 5, Haiku 4.5".
function summarizeSubagents(labels) {
  const order = [], counts = new Map();
  for (const l of labels) {
    if (!counts.has(l)) { counts.set(l, 0); order.push(l); }
    counts.set(l, counts.get(l) + 1);
  }
  return order.map(l => (counts.get(l) > 1 ? counts.get(l) + '× ' : '') + l).join(', ');
}

let subModels = '';
try { subModels = summarizeSubagents(activeSubagentModels()); } catch (e) { subModels = ''; }

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
if (subModels) ms += `${C.sep} ⇢ ${RESET}${C.sub}${subModels}${RESET}`;
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
