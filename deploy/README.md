# deploy

Everything that puts this system onto a machine, one directory per concern.

| Directory | What runs there | Owner |
| --- | --- | --- |
| [`dev/`](dev/) | Postgres 16 for local development. The app itself runs on the host, not in a container | ticket 001 |
| [`host/`](host/) | Provisioning a real Linux host to run agent sessions: accounts, the scoped sudo grant, directories, dev TLS material | unowned (see below) / ticket 007 owns `sudoers.d/office` |
| [`vps-sim/`](vps-sim/) | A container that provisions itself with `host/provision-host.sh`, for the host-shaped checks that do not need a real VPS | — |
| [`linux-check/`](linux-check/) | Runs the repo's own test suite on Linux, in the provisioned image, against the dev database | — |

```sh
# local dev database
docker compose -f deploy/dev/compose.yml up -d

# provision a real host (as root, on the box)
deploy/host/provision-host.sh

# the simulator
docker compose -f deploy/vps-sim/compose.yml build
docker compose -f deploy/vps-sim/compose.yml run --rm vps-sim

# the suite, on Linux (needs deploy/dev up first — it joins that network)
docker compose -f deploy/linux-check/compose.yml run --rm linux-check
```

## The suite on the real target, 2026-10-07

Until this date every test run had happened on Windows, on a WSL2 Ubuntu, or in a container on
Docker Desktop — and that container runs the **same WSL2 kernel**, which is why `vps-sim/README.md`
says it has no fidelity for timings or memory. The suite has now run on the real VPS
(`rtdvps`, Ubuntu 26.04.1, kernel 7.0.0-34-generic, 4 threads of an i3-7100T, 3.2 GB).

| | Windows baseline | real VPS |
| --- | --- | --- |
| files / tests | 21 / 389 passed, 1 skipped | **21 / 389 passed, 1 skipped** (four consecutive runs) |
| suite duration | ~35 s | **19.2–19.7 s** |
| peak RSS, whole pipeline | — | 298–304 MB |
| swap used | — | 4 MB of 3 840 |
| OOM kills | — | zero |

**No Linux-only failure exists.** Four runs, identical counts, `typecheck` clean on all three
packages, exit 0 every time. The `.gitattributes` `eol=lf` rules meant the CRLF-shebang trap never
fired — verified byte for byte after transfer.

**Linux is roughly 45% faster on weaker hardware**, which is a real behaviour difference and in the
right direction: the deploy target runs the suite in a bit over half the time the development
machine does.

**3.2 GB is comfortable for the suite.** Minimum `MemAvailable` during the run was 1 439 MB, and
that was the cold run including `pnpm install`. Nothing here argues against the deploy target.

### One watch item: the 50 ms p95 budget has thinner headroom here

`events/ingest` asserts a p95 under 50 ms across 200 sequential POSTs. On the VPS that is normally
~4.0 ms — but one run of four went to **26.76 ms**, with p50 jumping 2.2 → 14.8 ms and several
database suites running 3–6× slower. The next two runs reproduced ~4.0 ms, so it was transient
contention on a 4-thread box, not a regression.

The finding is not "the test is flaky". It is that **the margin is smaller than the Windows numbers
suggest, and the thing that consumed it was ordinary co-tenancy on a small host.** This box has four
other people's accounts on it. A timing assertion with a fixed bound will eventually go red for a
reason that has nothing to do with the code — which is the same lesson the tmux spike recorded about
this host's clock stepping backwards. Assert on percentiles, keep the bound generous, and expect to
revisit it when the office is actually running alongside the suite.

### Two environment facts worth knowing before running it

- **The TLS key is `0600 office:office`.** `provision-host.sh` makes the certificate world-readable
  and the key deliberately not, so the suite's TLS cases pass as `root` or `office` and **fail for
  any other user** — a permissions fact, not a test bug. Run it as one of those two.
- **The `host.docker.internal` password-auth failure is Docker-Desktop-specific.** The trap recorded
  elsewhere in this repo — that reaching the dev database from another container must join
  `ai_office_default` and use `db:5432`, because `host.docker.internal:5432` fails *password* auth
  under Docker Desktop's proxy — **does not apply here.** On the VPS,
  `postgresql://office:office@127.0.0.1:5432/office` over the published port authenticates fine, and
  joining the compose network is not required.

### How it was actually run, and why not through `linux-check/compose.yml`

On the real host the container **subtracts** fidelity: `vps-sim/Dockerfile` builds on Debian
bookworm, so a containerised run would test Debian's glibc and OpenSSL instead of Ubuntu 26.04's,
and would bypass the real provisioned accounts and the real TLS material. The Dockerfile also
installs Claude Code and runs `claude --version` at build time, which is a live process nobody
should trigger incidentally.

So `linux-check/run.sh` was run **unmodified**, directly on the host, parameterised through its own
knobs — it already supports this and needed no change:

```sh
SRC=/root/linux-check/orchestrator WORK=/tmp/linux-check DB_URL=postgresql://office:office@127.0.0.1:5432/office PNPM=pnpm@12.5.1 bash deploy/linux-check/run.sh
```

Only Postgres ran in a container, which is what `dev/compose.yml` intends. The tree was shipped with
`git archive HEAD | ssh … tar -x`: a clone needs credentials the VPS does not have, and the host's
`node_modules` is built for Windows and cannot be reused (`run.sh` already excludes it).

`host/` and `vps-sim/` share one provisioning script on purpose: it runs at image build time and
on the VPS as root, so the two cannot drift apart. Host provisioning is the step **no ticket in
steps 1–3 owns** — see [`vps-sim/README.md`](vps-sim/README.md), which also records what the
simulator proves, what it cannot (RSS and timings), and a harness bug worth reading before any
VPS trip.
