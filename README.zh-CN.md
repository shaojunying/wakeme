# wakeme

[English](README.md)

跑一条长命令，在它需要你关注时把你叫醒：跑完了、失败了、**卡死了**、跑太久了，或者没通过你自己的健康检查。

它是给 Claude Code 这类 AI 编程 agent 用的。agent 把长任务作为后台命令启动后，只有这条命令退出时才会被唤醒。任务卡死时命令永远不退出，agent 就一直等下去。`wakeme` 把任务包一层，把每一种结局（包括卡死）都变成一次退出，并给出明确的最后一行和退出码。

```sh
wakeme --idle 10m -- npm run build
wakeme --idle 15m --expect out/model.bin -- "python train.py"
wakeme --idle 10m -- ssh box1 "cd proj && ./run.sh"
wakeme --idle 10m -- wsl -e bash -lc "uv run pytest"
```

单文件，零依赖，Node 18+。在 Windows 和 Linux 上测试过。

## 安装

```sh
npm link                                        # 在本目录执行，把 `wakeme` 放到 PATH 上
ln -s "$PWD/wakeme.mjs" ~/.local/bin/wakeme     # Linux / WSL 也可以这样
```

命令前的 `--` 可以省略：PowerShell 调用 `wakeme.ps1` 这类脚本时会把 `--` 吞掉，所以 `wakeme` 会把第一个不是自己选项的参数当作命令的开头。命令本身以 `-` 开头时要保留 `--`。

## 给 AI agent 的用法

1. 用 `wakeme ... -- <命令>` 作为**后台命令**启动任务。`--idle` 设成健康运行时可能出现的最长静默时间；知道"健康的结果长什么样"时加上 `--expect` 或 `--check`。
2. 去做别的事，不要轮询。
3. 后台命令退出时，读它的最后一行和退出码（见下表）。
4. 如果报 `STALLED` 而任务其实没问题，用 `wakeme --attach <名字> --idle <更长的时间>` 作为新的后台命令继续等。如果真的卡死了，用 `wakeme --stop <名字>`。

**`--idle` 怎么设：** 任务结束时，最后一行还会带上 `longest silence <时长>`，即这次运行里最长的一段静默（`<名字>.json` 里的 `longest_silence_s` 也有）。先跑一次，再把 `--idle` 设成明显大于它的值，比如它的两三倍。

## 怎么判断卡死

只看"没输出"不可靠：编译器或下载可以很久不出声但完全正常。所以 `wakeme` 用两个信号。

1. 超过 `--idle`（默认 10 分钟）没有输出。
2. 任务及其子进程的 CPU 时间。没输出且 CPU 空闲，判为 **STALLED**。没输出但 CPU 还在转，先不报，宽限到 `--idle-busy`（默认是 `--idle` 的 6 倍）。

`--no-cpu` 表示只按输出判断。CPU 信号只能看到本机的进程：任务在 `ssh` 或 `wsl` 后面时，本机那个进程怎样都是空闲的，这种情况只能靠输出判断。

电脑休眠的时间不算作静默。

## 结局一览

最后一行固定是 `WAKEME <名字> <状态>: <原因> ...`。

| 退出码 | 状态 | 含义 |
|:--|:--|:--|
| 命令自己的退出码 | `DONE` / `FAILED` | 任务结束了，0 是成功，其他是失败 |
| 121 | `ENDED` | 任务不在了，也没留下退出码（被杀掉了） |
| 122 | `EXPECT` | 退出码是 0，但 `--expect` 指定的文件不存在、为空或比这次运行旧 |
| 123 | `CHECK` | 你的 `--check` 报警了，或者检查本身坏了 |
| 124 | `TIMEOUT` | 超过 `--timeout` 还在跑 |
| 125 | `STALLED` | 超过 `--idle` 没有输出 |
| 130 | `STOPPED` | wakeme 自己被中断（Ctrl+C），任务会被杀掉 |
| 2 | | 用法错误 |

如果命令自己恰好以上面某个数字退出，最后一行仍会写 `FAILED: exit code N`，所以退出码有歧义时以最后一行为准。

## 任务比观察者活得久

报 `STALLED`、`TIMEOUT`、`CHECK` 时，默认**不杀任务**，因为一次误报不应该毁掉跑了两小时的任务。想连子进程一起停掉就加 `--kill`。

能做到这一点，是因为每个任务都跑在自己的一个小监工进程下面，和 `wakeme` 以及启动它的东西都脱离。这在 agent 环境里很重要：Windows 上的 Claude Code 会在后台命令结束时清理它名下的进程，普通方式启动的任务会跟着死。监工能活下来，继续写日志，并记录退出码。

```sh
wakeme --attach train --idle 30m    # 重新接上继续等，仍能拿到真实退出码
wakeme --stop train                 # 杀掉任务及其子进程
wakeme --list                       # 哪些在跑、哪些结束了、怎么结束的
```

任务在没人看的时候结束了，之后再 `--attach` 也能得到它是怎么结束的。

## 自定义健康检查

有些问题只有你的项目自己看得出来，比如 loss 变成 NaN 而任务还在正常打印。

```sh
wakeme --check "python tools/check_loss.py" --check-every 5m -- "python train.py"
```

检查命令每隔 `--check-every`（默认 5 分钟）在 shell 里跑一次，环境变量里有 `WAKEME_LOG`、`WAKEME_PID`、`WAKEME_NAME`，限时 30 秒。退出码 0 表示正常，1 表示叫醒你并带上它打印的内容，其他值算检查本身坏了，同样会叫醒你。

## 常用选项

完整列表见 `wakeme --help`。

| 选项 | 作用 |
|:--|:--|
| `--idle D` | 超过 `D` 没输出算卡死（默认 `10m`，`0` 关闭） |
| `--timeout D` | 观察超过 `D` 就放弃 |
| `--expect FILE` | 退出码 0 但没有这个文件算失败，可重复 |
| `--check CMD` | 你的健康检查 |
| `--kill` | 因卡死、超时、检查报警而唤醒时，同时杀掉任务 |
| `--name NAME` | 给任务起名，用于 `--attach` / `--stop` 和文件名 |
| `--quiet` | 不透传输出，唤醒时只打印最后 `--tail` 行 |
| `--shell EXE` | 运行带引号命令用的 shell，比如 `powershell` 或 `bash` |

命令写成**一个带引号的字符串**时在 shell 里运行（可以用管道、`&&`、变量），写成多个参数时直接运行。

## 文件

在 `~/.wakeme/`（或 `$WAKEME_HOME`）下：`<名字>.log` 是任务的全部输出，`<名字>.json` 是观察者最后的结论，`<名字>.exit` 是任务如何结束。这些文件不会自动删除。

## 限制

- 电脑休眠期间什么都发现不了。
- `ssh` 任务的连接断了，远端任务通常跟着死，`wakeme` 会报 `FAILED`。它不负责让远端任务存活，那要在远端用 `nohup` 或 `tmux`。
- 报 `STALLED` 且没加 `--kill` 之后，在你重新 `--attach` 之前没人盯着任务。
- 被留下的任务在 session 结束后还会继续跑，用 `wakeme --list` 可以看到。

## 测试

```sh
npm test
```

测试用的是真实进程，大约跑一分半钟。
