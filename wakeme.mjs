#!/usr/bin/env node
// wakeme: run a command and exit as soon as it needs attention, so the agent
// that started it as a background command gets woken up.
// It exits when the command finishes, fails, goes silent (stalls), runs too
// long, or fails your own health check. Zero dependencies.
//
// Two processes per job:
//   supervisor  detached; starts the command, sends its output to a log file,
//               and records the exit code in <name>.exit. It outlives the watcher.
//   watcher     this process; follows the log and the exit file and decides
//               when to wake you. Any number of watchers can come and go.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT = { USAGE: 2, ENDED: 121, EXPECT: 122, CHECK: 123, TIMEOUT: 124, STALLED: 125, STOPPED: 130 };
const BUSY_RATE = 0.03; // CPU seconds per second across the process tree that counts as "working"
const IS_WIN = process.platform === 'win32';
const HOME = process.env.WAKEME_HOME || path.join(os.homedir(), '.wakeme');
const files = (name) => ({
  log: path.join(HOME, `${name}.log`),
  status: path.join(HOME, `${name}.json`),
  spec: path.join(HOME, `${name}.spec.json`),
  exit: path.join(HOME, `${name}.exit`),
});

const HELP = `usage: wakeme [options] [--] <command>  start a job and watch it
       wakeme --attach NAME [options]    watch a job that is already running
       wakeme --stop NAME                kill a job and its children
       wakeme --list                     show the jobs wakeme knows about

Runs <command>, passes its output through, and exits when it needs attention.
Pass the command as ONE quoted string to run it in a shell, or as separate
arguments to run it directly.

The job runs under its own supervisor, so it keeps going when wakeme exits or
is killed. --attach NAME picks it up again, for example after a STALLED false
alarm, and still learns the exit code.

options:
  --idle D         stalled after D without output (default 10m; 0 turns it off)
  --idle-busy D    stalled after D without output even if the CPU is busy
                   (default 6x --idle)
  --no-cpu         judge a stall by output only, ignore CPU usage
  --timeout D      give up after D of watching (default: no limit)
  --check CMD      health check, run in a shell every --check-every;
                   exit 0 = fine, exit 1 = wake me with what it printed
  --check-every D  how often to run --check (default 5m)
  --expect FILE    exit 0 without this file (non-empty, newer than the start)
                   counts as failed; repeatable
  --kill           when waking for a stall, timeout or check, also kill the
                   job and its children (default: leave it running)
  --name NAME      name for the job's files (default: job-<time>)
  --shell EXE      shell for a quoted command and for --check
                   (default: cmd.exe on Windows, /bin/sh elsewhere)
  --quiet          do not pass the output through; print only the last
                   --tail lines when waking
  --tail N         lines of log to print when waking in --quiet mode, and
                   when attaching (default 20)

durations: 90s, 10m, 2h; a bare number is seconds.

exit codes:
  the command's own code when it ends (0 = DONE, anything else = FAILED)
  121 ENDED    the job is gone and left no exit code (it was killed)
  122 EXPECT   ended with 0 but an --expect file is missing, empty or old
  123 CHECK    your --check spoke up, or is broken
  124 TIMEOUT  still running after --timeout
  125 STALLED  no output for --idle
  130 STOPPED  wakeme itself was interrupted; the job is killed
  2   bad usage

The last line printed is always "WAKEME <name> <STATE>: <why> ...". Once the job
has ended it also gives the longest silence seen: set the next --idle well above it.
Files are in ~/.wakeme/ (or $WAKEME_HOME): <name>.log, <name>.json, <name>.exit.`;

function die(msg) {
  process.stderr.write(`wakeme: ${msg}\n(wakeme --help for usage)\n`);
  process.exit(EXIT.USAGE);
}

function parseDuration(text, flag) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text));
  if (!m) die(`${flag}: "${text}" is not a duration (use 90s, 10m, 2h)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 's'];
}

function fmt(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function parseArgs(argv) {
  const o = { idle: 600000, idleBusy: null, cpu: true, timeout: 0, check: null, checkEvery: 300000,
    expect: [], kill: false, name: null, shell: null, quiet: false, tail: 20, attach: null, stop: null, list: false };
  // The command starts after "--", or at the first argument that is not an option.
  // "--" has to be optional: PowerShell drops it when it calls a script, such as
  // the wakeme.ps1 shim that npm installs.
  const TAKES_VALUE = new Set(['--idle', '--idle-busy', '--timeout', '--check', '--check-every', '--expect',
    '--name', '--attach', '--stop', '--shell', '--tail']);
  const flags = [];
  let cmd = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { cmd = argv.slice(i + 1); break; }
    if (!a.startsWith('-')) { cmd = argv.slice(i); break; }
    flags.push(a);
    if (TAKES_VALUE.has(a) && i + 1 < argv.length) flags.push(argv[++i]);
  }
  if (flags.includes('--help') || flags.includes('-h')) { console.log(HELP); process.exit(0); }
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const val = () => (i + 1 < flags.length ? flags[++i] : die(`${f} needs a value`));
    if (f === '--idle') o.idle = parseDuration(val(), f);
    else if (f === '--idle-busy') o.idleBusy = parseDuration(val(), f);
    else if (f === '--no-cpu') o.cpu = false;
    else if (f === '--timeout') o.timeout = parseDuration(val(), f);
    else if (f === '--check') o.check = val();
    else if (f === '--check-every') o.checkEvery = parseDuration(val(), f);
    else if (f === '--expect') o.expect.push(val());
    else if (f === '--kill') o.kill = true;
    else if (f === '--name') o.name = val();
    else if (f === '--attach') o.attach = val();
    else if (f === '--stop') o.stop = val();
    else if (f === '--list') o.list = true;
    else if (f === '--shell') o.shell = val();
    else if (f === '--quiet') o.quiet = true;
    else if (f === '--tail') { o.tail = Number(val()); if (!Number.isInteger(o.tail) || o.tail < 0) die('--tail needs a whole number'); }
    else die(`unknown option ${f}`);
  }
  const existing = o.attach || o.stop;
  if (existing || o.list) {
    if (cmd.length) die('--attach, --stop and --list work on existing jobs; do not give a command');
    if (o.name) die('the job is already named; drop --name');
    o.name = existing;
  } else {
    if (!cmd.length) die('no command given; put it after the options (and after "--" if it starts with "-")');
  }
  if (o.idleBusy === null) o.idleBusy = o.idle * 6;
  if (o.idleBusy < o.idle) die('--idle-busy must not be shorter than --idle');
  if (o.name && !/^[\w.-]+$/.test(o.name)) die('the name may only contain letters, digits, ".", "_" and "-"');
  return { o, cmd };
}

// How to run a command line in a shell: [exe, args, extra spawn options].
function shellInvocation(shell, line) {
  const base = shell ? path.basename(shell).toLowerCase().replace(/\.exe$/, '') : IS_WIN ? 'cmd' : 'sh';
  if (base === 'cmd') {
    return [shell || process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true }];
  }
  if (base === 'pwsh' || base === 'powershell') {
    return [shell, ['-NoProfile', '-NonInteractive', '-Command', line], {}];
  }
  return [shell || '/bin/sh', ['-c', line], {}];
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); try { fs.rmSync(tmp); } catch { /* gone */ } }
}

// --- supervisor: starts the command, keeps the log, records how it ended -----
function supervise(name) {
  const f = files(name);
  const spec = readJson(f.spec);
  const ended = (fields) => { writeJsonAtomic(f.exit, { ...fields, ended: new Date().toISOString() }); process.exit(0); };
  if (!spec) process.exit(1);
  for (const sig of ['SIGHUP', 'SIGINT']) process.on(sig, () => {}); // only the job's end, or a kill, ends us
  let child;
  try {
    const logFd = fs.openSync(f.log, 'a');
    // No console of our own, so a console program gets a fresh hidden one (windowsHide).
    const opts = { stdio: ['ignore', logFd, logFd], windowsHide: true };
    if (spec.cmd.length === 1) {
      const [exe, args, extra] = shellInvocation(spec.shell, spec.cmd[0]);
      child = spawn(exe, args, { ...opts, ...extra });
    } else {
      child = spawn(spec.cmd[0], spec.cmd.slice(1), opts);
    }
    fs.closeSync(logFd);
  } catch (e) {
    ended({ error: e.message });
  }
  child.on('error', (e) => ended({ error: e.message }));
  child.on('exit', (code, signal) => ended({ code, signal }));
}

// CPU seconds used so far by pid and its live descendants, or null if unknown.
function treeCpuSeconds(pid, track) {
  return new Promise((resolve) => {
    const done = (rows) => {
      if (!rows) return resolve(null);
      const kids = new Map();
      const cpu = new Map();
      for (const [p, pp, t] of rows) {
        cpu.set(p, t);
        if (!kids.has(pp)) kids.set(pp, []);
        kids.get(pp).push(p);
      }
      if (!cpu.has(pid)) return resolve(null);
      let total = 0;
      const seen = new Set();
      const todo = [pid];
      while (todo.length) {
        const p = todo.pop();
        if (seen.has(p)) continue;
        seen.add(p);
        total += cpu.get(p) || 0;
        for (const k of kids.get(p) || []) todo.push(k);
      }
      resolve(total);
    };
    let proc;
    if (IS_WIN) {
      const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ($_.KernelModeTime + $_.UserModeTime) }";
      proc = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 }, (err, out) => {
          track.delete(proc);
          if (err) return done(null);
          done(out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number))
            .filter((r) => r.length === 3 && r.every(Number.isFinite))
            .map(([p, pp, t]) => [p, pp, t / 1e7])); // 100 ns units
        });
    } else {
      proc = execFile('ps', ['-A', '-o', 'pid=,ppid=,time='], { timeout: 20000, maxBuffer: 8 << 20 }, (err, out) => {
        track.delete(proc);
        if (err) return done(null);
        done(out.split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length === 3)
          .map(([p, pp, t]) => [Number(p), Number(pp), parsePsTime(t)])
          .filter((r) => r.every(Number.isFinite)));
      });
    }
    track.add(proc);
  });
}

function parsePsTime(t) { // [DD-]HH:MM:SS or MM:SS.ss
  let days = 0;
  if (t.includes('-')) { const [d, rest] = t.split('-'); days = Number(d); t = rest; }
  const secs = t.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  return days * 86400 + secs;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Kills the supervisor and everything under it.
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pidAlive(pid)) return resolve();
    if (IS_WIN) return execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    const send = (sig) => {
      try { process.kill(-pid, sig); return true; } catch { /* no such group */ }
      try { process.kill(pid, sig); return true; } catch { return false; }
    };
    if (!send('SIGTERM')) return resolve();
    const t0 = Date.now();
    const poll = setInterval(() => {
      const alive = pidAlive(pid);
      if (!alive || Date.now() - t0 > 5000) {
        clearInterval(poll);
        if (alive) send('SIGKILL');
        resolve();
      }
    }, 200);
  });
}

function lastLines(file, n) {
  if (!n) return '';
  try {
    const size = fs.statSync(file).size;
    const want = Math.min(size, 16384);
    const buf = Buffer.alloc(want);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, want, size - want);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/);
    return lines.slice(-n).join('\n');
  } catch { return ''; }
}

function localStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// What a job is doing right now, from its files and its pid.
function liveState(name) {
  const f = files(name);
  const st = readJson(f.status);
  if (!st) return null;
  const ex = readJson(f.exit);
  if (ex) return { st, text: ex.error ? `failed to start: ${ex.error}` : ex.signal ? `killed by ${ex.signal}` : `ended, exit code ${ex.code}`, running: false };
  if (pidAlive(st.pid)) return { st, text: `running, pid ${st.pid}`, running: true };
  return { st, text: 'gone, exit code unknown', running: false };
}

function list() {
  let names = [];
  try { names = fs.readdirSync(HOME).filter((n) => n.endsWith('.json') && !n.endsWith('.spec.json')).map((n) => n.slice(0, -5)); } catch { /* no home yet */ }
  const rows = names.map((n) => ({ n, live: liveState(n) })).filter((r) => r.live)
    .sort((a, b) => String(b.live.st.started).localeCompare(String(a.live.st.started)));
  if (!rows.length) return console.log(`no jobs in ${HOME}`);
  for (const { n, live } of rows) {
    console.log(`${n}  ${live.text}  started ${live.st.started}  ${[].concat(live.st.cmd).join(' ').slice(0, 80)}`);
  }
}

async function stop(name) {
  const live = liveState(name);
  if (!live) die(`no job named ${name} in ${HOME}`);
  if (!live.running) return console.log(`WAKEME ${name} is not running: ${live.text}`);
  await killTree(live.st.pid);
  writeJsonAtomic(files(name).status, { ...live.st, state: 'STOPPED', why: 'wakeme --stop', exit_code: EXIT.STOPPED,
    ended: new Date().toISOString(), still_running: false });
  console.log(`WAKEME ${name} STOPPED: killed pid ${live.st.pid} and its children`);
}

function watch(o, cmd) {
  const watchStarted = Date.now();
  fs.mkdirSync(HOME, { recursive: true });
  const name = o.name || `job-${localStamp(watchStarted)}`;
  const f = files(name);
  process.stdout.on('error', () => {}); // the reader may go away; keep watching and write the status file

  let pid;
  let jobStarted = watchStarted;
  let jobCmd = cmd;
  let offset = 0;
  if (o.attach) {
    const prev = readJson(f.status);
    if (!prev) die(`no job named ${name} in ${HOME}`);
    pid = prev.pid;
    jobCmd = prev.cmd;
    jobStarted = Date.parse(prev.started) || watchStarted;
    try { offset = fs.statSync(f.log).size; } catch { die(`the log of ${name} is missing: ${f.log}`); }
    const seen = lastLines(f.log, o.tail);
    if (seen && !o.quiet) process.stdout.write(`${seen}\n`);
  } else {
    const live = liveState(name);
    if (live && live.running) die(`a job named ${name} is still running (pid ${live.st.pid}); use --attach ${name}, --stop ${name}, or another --name`);
    try { fs.rmSync(f.exit, { force: true }); } catch { /* none */ }
    fs.writeFileSync(f.log, '');
    writeJsonAtomic(f.spec, { cmd, shell: o.shell });
    // Detached: it must not die with us, nor with the terminal or agent harness that started us.
    const sup = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervise', name],
      { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, WAKEME_HOME: HOME } });
    sup.unref();
    pid = sup.pid;
    if (!pid) die('could not start the supervisor');
  }
  const readFd = fs.openSync(f.log, 'r');

  const aux = new Set(); // helper processes (CPU sampler, check) to clean up on exit
  let finished = false;
  let lastOutput = watchStarted;
  let longestSilence = 0; // the longest gap between two bits of output, to help pick --idle
  let goneSince = 0;
  const chunk = Buffer.alloc(65536);
  const samples = []; // {t, cpu} taken during the current silence

  const writeStatus = (fields) => {
    try {
      writeJsonAtomic(f.status, { name, cmd: jobCmd, pid, log: f.log, started: new Date(jobStarted).toISOString(), ...fields });
    } catch { /* status is best effort */ }
  };

  const pump = () => {
    let grew = false;
    for (;;) {
      let n = 0;
      try { n = fs.readSync(readFd, chunk, 0, chunk.length, offset); } catch { break; }
      if (!n) break;
      offset += n;
      grew = true;
      if (!o.quiet) process.stdout.write(chunk.subarray(0, n));
    }
    if (grew) {
      const now = Date.now();
      longestSilence = Math.max(longestSilence, now - lastOutput);
      lastOutput = now;
      samples.length = 0;
    }
  };

  const finish = async (state, why, code, jobAlive) => {
    if (finished) return;
    finished = true;
    clearInterval(ticker);
    for (const p of aux) { try { p.kill(); } catch { /* gone */ } }
    let tail = '';
    let killed = false;
    if (jobAlive) {
      if (o.kill || state === 'STOPPED') { await killTree(pid); killed = true; tail = ' · killed'; }
      else tail = ` · still running, pid ${pid} (wakeme --attach ${name} to keep watching, --stop ${name} to kill)`;
    }
    pump();
    writeStatus({ state, why, exit_code: code, ended: new Date().toISOString(), still_running: Boolean(jobAlive) && !killed,
      longest_silence_s: Math.round(longestSilence / 1000) });
    // Once a job has ended, its longest silence is the number to base the next --idle on.
    const quietest = jobAlive ? '' : ` · longest silence ${fmt(longestSilence)}`;
    const shown = o.quiet ? lastLines(f.log, o.tail) : '';
    const line = `${shown ? `${shown}\n` : ''}\nWAKEME ${name} ${state}: ${why} · ran ${fmt(Date.now() - jobStarted)}${quietest}${tail} · log ${f.log}\n`;
    process.stdout.write(line, () => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref(); // if stdout is gone the callback may never run
  };

  // The job is over: ex is what the supervisor recorded, or null if it left nothing.
  const jobEnded = (ex) => {
    pump();
    if (ex && ex.error) return finish('FAILED', `cannot start the command: ${ex.error}`, 127, false);
    if (ex && ex.signal) return finish('FAILED', `killed by ${ex.signal}`, 1, false);
    if (ex && ex.code !== 0) return finish('FAILED', `exit code ${ex.code}`, ex.code, false);
    const said = ex ? 'exit code 0' : 'the job is gone';
    for (const file of o.expect) {
      let st = null;
      try { st = fs.statSync(file); } catch { /* missing */ }
      const bad = !st ? 'is missing' : st.size === 0 ? 'is empty' : st.mtimeMs < jobStarted - 1000 ? 'is older than this run' : null;
      if (bad) return finish('EXPECT', `${said} but ${file} ${bad}`, EXIT.EXPECT, false);
    }
    if (ex) return finish('DONE', 'exit code 0', 0, false);
    finish('ENDED', 'the job is gone and left no exit code (killed?); read the log to see how far it got', EXIT.ENDED, false);
  };

  // --- stall detection: silence first, CPU as the second opinion -------------
  let cpuOn = o.cpu && o.idle > 0;
  let sampling = false;
  let lastSampleAt = 0;
  let cpuFailures = 0;
  const sampleEvery = Math.min(60000, Math.max(2000, o.idle / 4));

  const takeSample = async () => {
    sampling = true;
    lastSampleAt = Date.now();
    const silenceStart = lastOutput;
    const cpu = await treeCpuSeconds(pid, aux);
    sampling = false;
    if (finished) return;
    if (cpu === null) { if (++cpuFailures >= 2) cpuOn = false; return; }
    if (lastOutput !== silenceStart) return; // output arrived meanwhile: sample is stale
    samples.push({ t: Date.now(), cpu });
    if (samples.length > 2) samples.shift();
  };

  const checkStall = (now) => {
    const silent = now - lastOutput;
    if (cpuOn && silent >= o.idle / 2 && !sampling && now - lastSampleAt >= sampleEvery) takeSample();
    if (silent < o.idle) return;
    let busy = false;
    let note = '';
    if (cpuOn) {
      if (samples.length === 2) {
        const delta = samples[1].cpu - samples[0].cpu;
        const secs = (samples[1].t - samples[0].t) / 1000;
        busy = delta < 0 || delta / secs >= BUSY_RATE; // a shrinking total means processes came and went
        note = busy ? 'CPU busy' : 'CPU idle';
      } else if (silent < o.idle + 3 * sampleEvery + 20000) {
        return; // wait for the second sample
      } else {
        note = 'CPU unknown';
      }
    }
    if (!busy) finish('STALLED', `no output for ${fmt(silent)}${note ? `, ${note}` : ''}`, EXIT.STALLED, true);
    else if (silent >= o.idleBusy) finish('STALLED', `no output for ${fmt(silent)}, though the CPU is busy`, EXIT.STALLED, true);
  };

  // --- your own health check -------------------------------------------------
  let checking = false;
  let lastCheckAt = watchStarted;
  const runCheck = () => {
    checking = true;
    lastCheckAt = Date.now();
    const [exe, args, extra] = shellInvocation(o.shell, o.check);
    const env = { ...process.env, WAKEME_NAME: name, WAKEME_LOG: f.log, WAKEME_PID: String(pid) };
    let out = '';
    let p;
    let timer;
    const settle = (code, text) => {
      aux.delete(p);
      clearTimeout(timer);
      checking = false;
      if (finished || code === 0) return;
      const said = (text || '').trim().split(/\r?\n/).slice(-3).join(' | ') || '(printed nothing)';
      if (code === 1) finish('CHECK', said, EXIT.CHECK, true);
      else finish('CHECK', `check is broken (${code === null ? 'did not finish in 30s or could not start' : `exit code ${code}`}): ${said}`, EXIT.CHECK, true);
    };
    try {
      p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, ...extra });
    } catch (e) {
      checking = false;
      return finish('CHECK', `check is broken (could not start): ${e.message}`, EXIT.CHECK, true);
    }
    aux.add(p);
    timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 30000);
    const collect = (d) => { if (out.length < 4000) out += d; };
    p.stdout.on('data', collect);
    p.stderr.on('data', collect);
    p.on('error', (e) => settle(null, e.message));
    p.on('close', (code) => settle(code, out));
  };

  let lastTick = watchStarted;
  let timeoutBase = watchStarted;
  const tick = () => {
    if (finished) return;
    pump();
    const now = Date.now();
    // A long gap between ticks means the machine slept or the clock jumped.
    // That time is not silence: push every deadline forward by it.
    const gap = now - lastTick;
    lastTick = now;
    if (gap > 5000 || gap < 0) {
      lastOutput += gap;
      lastCheckAt += gap;
      timeoutBase += gap;
      samples.length = 0;
    }
    const ex = readJson(f.exit);
    if (ex) return jobEnded(ex);
    if (!pidAlive(pid)) { // give a just-ended supervisor a moment to land its exit file
      if (!goneSince) goneSince = now;
      if (now - goneSince >= 1500) return jobEnded(readJson(f.exit));
      return;
    }
    goneSince = 0;
    if (o.timeout && now - timeoutBase >= o.timeout) {
      return finish('TIMEOUT', `still running after ${fmt(now - timeoutBase)} of watching`, EXIT.TIMEOUT, true);
    }
    if (o.check && !checking && now - lastCheckAt >= o.checkEvery) runCheck();
    if (o.idle > 0) checkStall(now);
  };
  const ticker = setInterval(tick, 250);

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => finish('STOPPED', `wakeme got ${sig}`, EXIT.STOPPED, pidAlive(pid)));
  }

  if (!o.attach) writeStatus({ state: 'RUNNING' });
  const limits = [o.idle > 0 ? `idle ${fmt(o.idle)}` : 'no idle limit', o.timeout ? `timeout ${fmt(o.timeout)}` : null,
    o.check ? `check every ${fmt(o.checkEvery)}` : null].filter(Boolean).join(', ');
  process.stdout.write(`wakeme: ${name} ${o.attach ? 'attached' : 'started'}, pid ${pid}, ${limits}, log ${f.log}\n`);
}

const argv = process.argv.slice(2);
if (argv[0] === '--supervise') {
  supervise(argv[1]);
} else {
  const { o, cmd } = parseArgs(argv);
  if (o.list) list();
  else if (o.stop) await stop(o.stop);
  else watch(o, cmd);
}
