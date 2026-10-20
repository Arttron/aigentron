# Small servers (2 vCPU, burstable: AWS t4g/t3.medium and similar)

Agents compile, run tests, drive a browser and call models at the same time; on 2 vCPU that is easily more than the machine can do, and on a burstable
instance the CPU credits run out and everything slows down together (timeouts, a dashboard that stops answering). What the server does about it:

- **Parallel runs** — Settings → *concurrency* (default 2). On a 2-vCPU machine use **1**; projects in `shared` mode already run one task at a time.
- **Load-aware starts** (since 0.1.79) — a new run is held, the task staying *queued*, while the 1-minute load average per CPU is above `AGENT_MAX_LOAD`
  (default 1.5, i.e. 3.0 on 2 vCPU) or free memory is below `AGENT_MIN_FREE_MEM_MB` (default 300). No run waits longer than 10 minutes (then it
  starts anyway), and the admin's chat is never held. Set a limit to `0` to switch it off; on a very small box try `AGENT_MAX_LOAD=1.0`.
  Ask the admin for `metrics_report` topic `system` to see the load, the memory and whether starts are being held.
- **Per-agent step limit** — `maxTurns` in the agent form keeps one run from going on for ever.

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
