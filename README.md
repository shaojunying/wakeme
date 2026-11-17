# wakeme

[中文](README.zh-CN.md)

Run a long command and get woken when it needs attention: when it finishes, fails, **hangs**, runs too long, or fails your own health check.

It is made for AI coding agents such as Claude Code. An agent that starts a long job as a background command is only woken when that command exits. A job that hangs never exits, so the agent waits forever. `wakeme` wraps the job and turns every outcome, including a hang, into an exit with a clear last line and exit code.

```sh
wakeme --idle 10m -- npm run build
wakeme --idle 15m --expect out/model.bin -- "python train.py"
wakeme --idle 10m -- ssh box1 "cd proj && ./run.sh"
wakeme --idle 10m -- wsl -e bash -lc "uv run pytest"
```

One file, no dependencies, Node 18+. Tested on Windows and Linux.

## For AI agents

1. Start the job with `wakeme ... -- <command>` as a **background command**. Set `--idle` to the longest silence a healthy run can have, and add `--expect` or `--check` when you know what a healthy run looks like.
2. Go on with other work. Do not poll.
3. When the background command exits, read its last line and exit code (table below).
4. If it says `STALLED` and the job is in fact fine, run `wakeme --attach <name> --idle <longer>` as a new background command. If the job is really stuck, `wakeme --stop <name>`.

**Picking `--idle`:** when a job ends, the last line also says `longest silence <D>`, the longest quiet stretch of that run (it is in `<name>.json` as `longest_silence_s` too). Run a job once, then set `--idle` comfortably above that, for example two or three times it.

## What counts as a hang

Silence alone is a poor signal: a compiler or a download can be quiet for a long time and be perfectly healthy. So `wakeme` uses two signals.

1. No output for `--idle` (default 10 minutes).
2. The CPU time of the job and its children. Silent and idle means **STALLED**. Silent but still burning CPU is given the benefit of the doubt until `--idle-busy` (default 6 x `--idle`).

`--no-cpu` judges by output only. The CPU signal only sees processes on this machine: for a job behind `ssh` or `wsl`, the local process is idle either way, so output is the only signal there.

Time the machine spends asleep is not counted as silence.

## Outcomes

The last line is always `WAKEME <name> <STATE>: <why> ...`.

| Exit | State | Meaning |
|:--|:--|:--|
| the command's code | `DONE` / `FAILED` | it ended; 0 is done, anything else failed |
| 121 | `ENDED` | the job is gone and left no exit code (it was killed) |
| 122 | `EXPECT` | exit 0, but an `--expect` file is missing, empty or older than the run |
| 123 | `CHECK` | your `--check` spoke up, or is broken |
| 124 | `TIMEOUT` | still running after `--timeout` |
| 125 | `STALLED` | no output for `--idle` |
| 130 | `STOPPED` | wakeme itself was interrupted (Ctrl+C); the job is killed |
| 2 | | bad usage |

A command that itself exits with one of these codes is still reported as `FAILED: exit code N` in the last line, so read the line when the code is ambiguous.

## The job outlives the watcher

On `STALLED`, `TIMEOUT` and `CHECK` the job is **left running** by default, because a false alarm should not cost you a two-hour job. Add `--kill` to stop it and its children instead.

This works because each job runs under its own small supervisor process, detached from `wakeme` and from whatever started it. That matters under an agent harness: Claude Code on Windows cleans up the processes of a background command when it ends, and a plainly started job dies with it. The supervisor survives, keeps the log going, and records the exit code.

```sh
wakeme --attach train --idle 30m    # watch it again; still learns the real exit code
wakeme --stop train                 # kill the job and its children
wakeme --list                       # what is running, what ended and how
```

`--attach` also works after the job has ended unwatched: it reports how it ended.

## Your own health check

Some failures only your project can see, such as a loss going to NaN while the job happily keeps printing.

```sh
wakeme --check "python tools/check_loss.py" --check-every 5m -- "python train.py"
```

The check runs in a shell every `--check-every` (default 5 minutes) with `WAKEME_LOG`, `WAKEME_PID` and `WAKEME_NAME` set, and has 30 seconds. Exit 0 means fine, exit 1 wakes you with what it printed, anything else counts as a broken check and wakes you too.

## Options

Run `wakeme --help` for all of them. The ones you will use most:

| Option | What it does |
|:--|:--|
| `--idle D` | stalled after `D` without output (default `10m`, `0` turns it off) |
| `--timeout D` | give up after `D` of watching |
| `--expect FILE` | exit 0 without this file counts as failed; repeatable |
| `--check CMD` | your health check |
| `--kill` | kill the job when waking for a stall, timeout or check |
| `--name NAME` | name the job, for `--attach` / `--stop` and its files |
| `--quiet` | do not pass output through; print only the last `--tail` lines when waking |
| `--shell EXE` | shell for a quoted command, for example `powershell` or `bash` |

Pass the command as **one quoted string** to run it in a shell (pipes, `&&`, variables), or as separate arguments to run it directly.

## Files

In `~/.wakeme/` (or `$WAKEME_HOME`): `<name>.log` holds everything the job printed, `<name>.json` the watcher's last verdict, `<name>.exit` how the job ended. Nothing there is deleted automatically.

## Limits

- Nothing notices anything while your machine sleeps.
- If the connection of an `ssh` job drops, the remote job usually dies with it and `wakeme` reports `FAILED`. It does not keep remote jobs alive; use `nohup` or `tmux` on the remote side for that.
- After a `STALLED` exit without `--kill`, nobody is watching until you `--attach` again.
- A job that was left running keeps running after your session ends. `wakeme --list` shows such jobs.

## Test

```sh
npm test
```

The tests run real processes and take about a minute and a half.
