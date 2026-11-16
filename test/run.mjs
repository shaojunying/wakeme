// Real-process tests: each case runs wakeme against a fake job and checks the
// exit code, the final WAKEME line, and whether the job was left alive or killed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wakeme = path.join(here, '..', 'wakeme.mjs');
const job = path.join(here, 'fixtures', 'job.mjs');
const checkFail = path.join(here, 'fixtures', 'check-fail.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeme-test-'));
const node = process.execPath;

function run(args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(node, [wakeme, ...args], { env: { ...process.env, WAKEME_HOME: home } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      const last = out.trim().split(/\r?\n/).pop() || '';
      const pid = Number((/pid (\d+)/.exec(out) || [])[1]);
      resolve({ code, out, last, pid, secs: (Date.now() - t0) / 1000 });
    });
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (s) => `"${s}"`;

let failed = 0;
let total = 0;
function report(name, r, problems) {
  total++;
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name} (${r.secs.toFixed(1)}s)${problems.length ? `: ${problems.join('; ')}` : ''}`);
  console.log(`       ${r.last}`);
}

// Checks one run: c.code, c.state (in the last line), c.says / c.lacks (anywhere),
// c.after ('alive' | 'dead': the job afterwards). Returns the run.
async function expectRun(c) {
  const r = await run(c.args);
  const problems = [];
  if (r.code !== c.code) problems.push(`exit code ${r.code}, wanted ${c.code}`);
  if (c.state && !r.last.includes(` ${c.state}`)) problems.push(`last line lacks ${c.state}`);
  if (c.says && !r.out.includes(c.says)) problems.push(`output lacks "${c.says}"`);
  if (c.lacks && r.out.includes(c.lacks)) problems.push(`output should not contain "${c.lacks.trim()}"`);
  if (c.after) {
    await sleep(700);
    const isAlive = alive(r.pid);
    if (c.after === 'alive' && !isAlive) problems.push('job should still be running');
    if (c.after === 'dead' && isAlive) problems.push('job should have been killed');
  }
  report(c.name, r, problems);
  return r;
}

const cases = [
  { name: 'finishes', args: ['--', node, job, 'chatty', '2'], code: 0, state: 'DONE:' },
  { name: 'fails with its own exit code', args: ['--', node, job, 'chatty', '1', '7'], code: 7, state: 'FAILED:' },
  { name: 'command that cannot start', args: ['--', 'no-such-program-wakeme-test', 'x'], code: 127, state: 'FAILED:', says: 'cannot start' },
  { name: 'hung with --kill', args: ['--idle', '3s', '--kill', '--', node, job, 'silent', '120'],
    code: 125, state: 'STALLED:', says: 'CPU idle', after: 'dead' },
  { name: 'quiet but working is not a stall', args: ['--idle', '3s', '--idle-busy', '60s', '--', node, job, 'busy', '12'],
    code: 0, state: 'DONE:' },
  { name: 'quiet and busy for too long', args: ['--idle', '3s', '--idle-busy', '9s', '--kill', '--', node, job, 'busy', '120'],
    code: 125, state: 'STALLED:', says: 'though the CPU is busy', after: 'dead' },
  { name: 'output only (--no-cpu)', args: ['--idle', '2s', '--no-cpu', '--kill', '--', node, job, 'busy', '120'],
    code: 125, state: 'STALLED:', after: 'dead' },
  { name: 'exit 0 without the expected file', args: ['--expect', path.join(home, 'missing.txt'), '--', node, job, 'chatty', '1'],
    code: 122, state: 'EXPECT:' },
  { name: 'exit 0 with the expected file', args: ['--expect', path.join(home, 'made.txt'), '--', node, job, 'chatty', '1', '0', path.join(home, 'made.txt')],
    code: 0, state: 'DONE:' },
  { name: 'health check speaks up', args: ['--check', `${quote(node)} ${quote(checkFail)}`, '--check-every', '2s', '--kill', '--', node, job, 'chatty', '120'],
    code: 123, state: 'CHECK:', says: 'loss is NaN (log known)', after: 'dead' },
  { name: 'total timeout', args: ['--timeout', '3s', '--kill', '--', node, job, 'chatty', '120'],
    code: 124, state: 'TIMEOUT:', after: 'dead' },
  { name: 'one quoted string runs in a shell', args: ['--', `${quote(node)} ${quote(job)} chatty 1 && echo chained`],
    code: 0, state: 'DONE:', says: 'chained' },
  { name: '--quiet prints only the tail', args: ['--quiet', '--tail', '2', '--', node, job, 'chatty', '2'],
    code: 0, state: 'DONE:', says: 'chatty done', lacks: 'step 1\n' },
  { name: 'bad usage', args: ['--idle', 'soon', '--', 'x'], code: 2 },
];
for (const c of cases) await expectRun(c);

// A stall that was a false alarm: the job is left running, a later watcher learns how it ended.
await expectRun({ name: 'hung: left running', args: ['--name', 'att1', '--idle', '2s', '--no-cpu', '--', node, job, 'silent', '8', '3'],
  code: 125, state: 'STALLED:', says: '--attach att1', after: 'alive' });
await expectRun({ name: 'attach waits and learns the exit code', args: ['--attach', 'att1', '--idle', '60s'],
  code: 3, state: 'FAILED: exit code 3', says: 'silent start' });

await expectRun({ name: 'left running (to be attached after it ended)', args: ['--name', 'att2', '--idle', '2s', '--no-cpu', '--', node, job, 'silent', '4'],
  code: 125, state: 'STALLED:' });
await sleep(3500);
await expectRun({ name: 'attach to a job that ended unwatched', args: ['--attach', 'att2'], code: 0, state: 'DONE:', says: 'silent done' });

const st = await expectRun({ name: 'left running (to be stopped)', args: ['--name', 'st1', '--idle', '2s', '--no-cpu', '--', node, job, 'silent', '120'],
  code: 125, state: 'STALLED:', after: 'alive' });
await expectRun({ name: 'same name while it runs is refused', args: ['--name', 'st1', '--', node, job, 'chatty', '1'], code: 2, says: 'still running' });
await expectRun({ name: '--list shows it running', args: ['--list'], code: 0, says: 'st1  running' });
{
  const r = await run(['--stop', 'st1']);
  await sleep(700);
  const problems = [];
  if (r.code !== 0) problems.push(`exit code ${r.code}, wanted 0`);
  if (!r.out.includes('STOPPED')) problems.push('output lacks STOPPED');
  if (alive(st.pid)) problems.push('job should have been killed');
  report('--stop kills it', r, problems);
}
await expectRun({ name: 'attach to a killed job', args: ['--attach', 'st1'], code: 121, state: 'ENDED:' });
await expectRun({ name: 'attach to an unknown job', args: ['--attach', 'nope'], code: 2, says: 'no job named' });

fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} of ${total} failed` : `\nall ${total} passed`);
process.exit(failed ? 1 : 0);
