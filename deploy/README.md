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

`host/` and `vps-sim/` share one provisioning script on purpose: it runs at image build time and
on the VPS as root, so the two cannot drift apart. Host provisioning is the step **no ticket in
steps 1–3 owns** — see [`vps-sim/README.md`](vps-sim/README.md), which also records what the
simulator proves, what it cannot (RSS and timings), and a harness bug worth reading before any
VPS trip.
