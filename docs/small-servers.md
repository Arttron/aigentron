# Small servers (2 vCPU, burstable: AWS t4g/t3.medium and similar)

Agents compile, run tests, drive a browser and call models at the same time; on 2 vCPU that is easily more than the machine can do, and on a burstable
instance the CPU credits run out and everything slows down together (timeouts, a dashboard that stops answering). What the server does about it:

- **Parallel runs** — Settings → *concurrency* (default 2; tick **Choose automatically** (stored as 0, since 0.1.82) and the server picks what the machine suits). On a 2-vCPU machine use **1**; projects in `shared` mode already run one task at a time.
- **Load-aware starts** (since 0.1.79) — a new run is held, the task staying *queued*, while the 1-minute load average per CPU is above `AGENT_MAX_LOAD`
  (default 1.5, i.e. 3.0 on 2 vCPU) or free memory is below `AGENT_MIN_FREE_MEM_MB` (default 300). No run waits longer than 10 minutes (then it
  starts anyway), and the admin's chat is never held. Set a limit to `0` to switch it off; on a very small box try `AGENT_MAX_LOAD=1.0`.
  Ask the admin for `metrics_report` topic `system` to see the load, the memory and whether starts are being held.
- **Spread-out starts** (since 0.1.82) — held runs no longer start together: they go through one at a time, at least `AGENT_START_GAP_S` (default 10) seconds
  apart, because the load average lags by a minute and two runs would both see "calm". `0` switches it off.
- **CPU steal** (since 0.1.82) — a burstable instance out of CPU credits is slowed down by the host, which shows as "steal" time long before the load average
  rises. A start is held while more than `AGENT_MAX_STEAL` % (default 20) of the CPU time is stolen. `0` switches it off.
- **Lower priority for agents** (since 0.1.82) — agent processes run at niceness `AGENT_NICE` (default 10; `0` = off), and so do the tests and builds they start, so the
  dashboard, SSH and the orchestrator itself keep the CPU when agents hog it. Works with and without the separate agent user.
- **Memory cap for builds and tests** (since 0.1.82) — the Node processes an agent starts (`tsc`, `vitest`, bundlers) get a heap cap through `NODE_OPTIONS`:
  a little over half of the RAM (2.2 GB on a 4 GB machine; none from 16 GB up). A runaway build then fails with "heap out of memory" instead of taking the whole
  machine down. `AGENT_NODE_MAX_MB=<n>` sets it, `0` switches it off.
- **A suggestion for parallel runs** — `metrics_report` topic `system` shows how many runs this machine suits (one less than the CPUs on a small box, and no more than
  memory allows) and says when Settings → *concurrency* is above it.
- **Per-agent step limit** — `maxTurns` in the agent form keeps one run from going on for ever.

- **Memory guard** (since 0.1.83) — when the memory available drops below `AGENT_OOM_GUARD_MB` (default 200) while runs are in flight, the **newest** run is
  stopped by the server (the task becomes *stalled*, the work stays, press *Continue* later) instead of the kernel killing the biggest process — which used to be
  the whole service (`aigentron.service: Failed with result 'oom-kill'` in the journal, then a restart and the same tasks running it out of memory again).
  New runs also wait while memory is short, up to an hour (load and CPU steal only up to 10 minutes). Agents ask the kernel to kill *them* first
  (`oom_score_adj 500`), and the unit has `OOMPolicy=continue`, so one killed process no longer stops the service. `0` switches the guard off.
- **A big enough swap is the single most useful thing on a 4 GB machine** (see below); the admin's `metrics_report system` says when there is none.

An existing installation gets `OOMPolicy=continue` with the next update; to have it at once:

```sh
sudo mkdir -p /etc/systemd/system/aigentron.service.d
printf '[Service]\nOOMPolicy=continue\n' | sudo tee /etc/systemd/system/aigentron.service.d/oom.conf
sudo systemctl daemon-reload   # takes effect at the next restart of the service
```

What to do on the machine itself:

```sh
# a safety net so SSH and the dashboard stay reachable even when agents hog the CPU (the unit is `aigentron`)
sudo systemctl set-property aigentron.service CPUQuota=170% MemoryHigh=3G
# swap, so a memory spike slows things down instead of killing the process
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

t4g instances start in *unlimited* credit mode (no throttling, but extra CPU-credit charges); check *CPUCreditBalance* / *CPUSurplusCreditBalance*
in CloudWatch, and the instance's credit specification (`aws ec2 describe-instance-credit-specifications`). A fixed-performance type (t4g → m7g / c7g)
is the real fix if the box is busy all day.
