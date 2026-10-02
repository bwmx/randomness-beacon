# Randomness beacon daemon

Serves a deployed [randomness beacon](../README.md). It wakes on every new block and plays one or both roles:

- **watcher** holds the beacon's VRF key. Once a round that requests wait on is committed, it proves that round's
  block seed and calls `submitProof` with `FirstValid = last committed round + 1`, so the proof lands in the very
  next block. One proof serves every request on the round.
- **keeper** needs no key. For each pending request whose round is proven, it calls `fulfillRequest`, which
  passes the request's randomness to the requesting app. It sends up to 16 fulfillments per transaction group;
  one failing callback fails its group, so those requests are then sent one by one.

`ROLE=both` (the default) groups each proof with up to 15 of its round's fulfillments, so callbacks run in the
block right after the target round. One failing callback fails the whole group, so it then submits the proof alone
and fulfills the requests individually from the next block. To keep the key away from callback execution, run
`ROLE=watcher` on the key's host and `ROLE=keeper` elsewhere; callbacks then run one block later.

**Status: development preview.** Do not operate this against production funds until the
[production blockers](../PRODUCTION_READINESS.md) are resolved. The reviewed P1/P2 fixes and LocalNet recovery tests
are implemented, along with standalone release checks. Production-network validation and operator alert delivery
remain release work.

On each new block (or after algod's one-minute wait expires) it reads global state and the relayer's balance, then
acts on pending requests in parallel. Boxes are read once and cached. Request boxes never change, so it lists them
again only when `nextRequestId` or `totalPendingRequests` changes and reads only new ones. A proven round stays
proven, and an unproven round's box is re-read only when the beacon's `totalProofs` counter changes. An idle block
therefore costs two reads however many requests are pending. For `age = last committed round - target round`:

| Request's round                | Watcher                                                  | Keeper      |
| ------------------------------ | -------------------------------------------------------- | ----------- |
| not committed (age < 0)        | wait                                                     | wait        |
| committed, unproven, age 0–990 | **prove**, including requests eligible for cancellation  | wait        |
| unproven, age ≥ 991            | wait: the seed is outside the proof's transaction window | wait        |
| proven                         | —                                                        | **fulfill** |

Cancellation is eligible on-chain when `Global.round > target round + timeout` **and the round is unproven**. A
proven round's outcomes are public, so its requests can only be fulfilled. The daemon never submits cancellation;
a user or keeper must invoke the requester app's expiry method (for example, `DiceCasino.expireBet` or
`ExampleCaller.expireRequest`). See [seed availability](../README.md#seed-availability).

The daemon can run with any funded relayer account. Its signer assumes an unrekeyed account controlled by
`MANAGER_MNEMONIC`; this environment variable keeps its existing name for compatibility. The signer need not hold
the beacon's manager role. Use this daemon with a beacon that has `submitProof` and `fulfillRequest`.

## Configuration

Read from the environment. The `pnpm run daemon:dev` / `pnpm run daemon:start` commands also load `.env` from the daemon directory;
the service templates use `/etc/randomness-beacon/daemon.env`. Before connecting, the loader validates the endpoint,
numeric bounds, mnemonic, and VRF key encoding and seed/public-key consistency, reporting configuration errors
together. Pino validates `LOG_LEVEL` separately.

| Variable           | Required       | Description                                                                              |
| ------------------ | -------------- | ---------------------------------------------------------------------------------------- |
| `ALGOD_SERVER`     | yes            | Absolute HTTP(S) URL; no credentials, query, or fragment. Never defaults to LocalNet.    |
| `ALGOD_PORT`       |                | Integer `1–65535`; overrides the URL port. Omit or leave empty to preserve the URL port. |
| `ALGOD_TOKEN`      |                | Algod API token; omit or leave empty for tokenless endpoints                             |
| `BEACON_APP_ID`    | yes            | Positive uint64 application ID (`1–18446744073709551615`)                                |
| `MANAGER_MNEMONIC` | yes            | 25-word mnemonic of the funded relayer account (legacy variable name)                    |
| `VRF_PRIVATE_KEY`  | not for keeper | Base64 64-byte VRF secret key matching the beacon's public key; ignored by a keeper      |
| `ROLE`             |                | `watcher`, `keeper`, or `both`; unset or empty defaults to `both`                        |
| `LOG_LEVEL`        |                | `trace`, `debug`, `info` (default), `warn`, `error`, `fatal`                             |

The loader derives the public key from the secret seed using the installed VRF library and rejects an inconsistent
64-byte keypair. A watcher then compares that key with the beacon's `publicKey` at startup. It does not verify the deployed
program. Each poll checks the signer's spendable balance. Manager transfers and renunciation do not
suspend fulfillment.

The daemon constructs only an algod client, retaining the SDK's request retries. Indexer and KMD settings are
unused, and custom tokenless endpoints do not require an explicit `ALGOD_TOKEN` value.

Generate a keypair with `pnpm run generate-keypair`; deploy the beacon with the public key and give the daemon
the secret key. The beacon cannot be re-keyed, so **back up `VRF_PRIVATE_KEY`**: losing it means deploying a new
beacon, and every pending request goes stale.

## Running locally

Install, build, and run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run build:all
cp daemon/.env.example daemon/.env    # fill in BEACON_APP_ID, MANAGER_MNEMONIC, VRF_PRIVATE_KEY
pnpm run daemon:dev                   # ts-node, copies the beacon's generated client first
```

On a terminal logs are pretty-printed; anywhere else (systemd, launchd, files) they are JSON lines. Read those with
`… | pnpm exec pino-pretty`.

## Service setup (after resolving production blockers)

### Build

Needs Node.js 22.12+ for the locked contract compiler and Oxc tools (the daemon declares a 22.9 runtime minimum),
pnpm 12.6, and the [AlgoKit CLI](https://github.com/algorandfoundation/algokit-cli). From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run build:all   # contract artifacts, typed client, and daemon dist/
```

The service runs `node dist/index.js`, so rebuild and restart it after pulling changes. Its templates expect this
repository at `/opt/randomness-beacon`, with the daemon at `/opt/randomness-beacon/daemon`. Keep runtime dependencies
installed; copying `dist/` alone is insufficient.

### Secrets

Run the following installation commands from this daemon directory. Put the configuration in
`/etc/randomness-beacon/daemon.env`, readable only by root (systemd reads it before
dropping privileges; the macOS steps below hand it to the service user instead):

```bash
sudo install -d -m 700 /etc/randomness-beacon
sudo install -m 600 .env.example /etc/randomness-beacon/daemon.env   # then edit it
```

Quote the mnemonic (`MANAGER_MNEMONIC="word1 … word25"`), and set `ROLE` here when splitting roles across hosts; a
keeper host's file should not contain `VRF_PRIVATE_KEY`. A successful proof or fulfillment pays the prepaid fee
back to the submitting relayer in the same transaction. Fund enough spendable balance for transaction fee checks and
concurrent requests. The daemon checks the fixed 0.1 ALGO warning threshold each poll; it is not a computed concurrency reserve.

### Linux (systemd)

[`deploy/randomness-beacon.service`](deploy/randomness-beacon.service) runs the daemon as a `beacon` system user
with a hardened sandbox, restarts it if it exits, and gives it 60 s to finish an in-flight poll on stop.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin beacon
sudo cp deploy/randomness-beacon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now randomness-beacon

systemctl status randomness-beacon
journalctl -u randomness-beacon -f -o cat | pnpm exec pino-pretty
```

The checkout must be readable by `beacon` and live outside `/home` (the unit sets `ProtectHome`). If `node` isn't in
`/usr/bin` or `/usr/local/bin` (e.g. nvm), put its absolute path in `ExecStart`.

### macOS (launchd)

[`deploy/io.github.bwmx.randomness-beacon.plist`](deploy/io.github.bwmx.randomness-beacon.plist) is a LaunchDaemon:
it starts at boot without anyone logged in, runs as `UserName`, and is restarted whenever it exits.

```bash
# node reads the env file as the service user, so it owns the secrets directory
sudo chown -R "$(whoami)" /etc/randomness-beacon
sudo install -d -m 700 -o "$(whoami)" /Library/Logs/randomness-beacon
sed "s/REPLACE_WITH_USER/$(whoami)/" deploy/io.github.bwmx.randomness-beacon.plist \
  | sudo tee /Library/LaunchDaemons/io.github.bwmx.randomness-beacon.plist >/dev/null
sudo launchctl bootstrap system /Library/LaunchDaemons/io.github.bwmx.randomness-beacon.plist

sudo launchctl print system/io.github.bwmx.randomness-beacon | grep -E 'state|pid|last exit'
tail -f /Library/Logs/randomness-beacon/daemon.log | pnpm exec pino-pretty
sudo launchctl kickstart -k system/io.github.bwmx.randomness-beacon   # restart after an upgrade
sudo launchctl bootout system/io.github.bwmx.randomness-beacon       # stop and unload
```

The plist expects Node at `/opt/homebrew/bin/node` (Apple silicon Homebrew); use `/usr/local/bin/node` on Intel or
the output of `command -v node`. For a login-session-only setup, drop the `UserName` key and load it from
`~/Library/LaunchAgents` with `launchctl bootstrap gui/$(id -u) …`. launchd keeps the log file open, so rotate it by
truncating (`: > daemon.log`) rather than moving it.

### Operating it

- **Run one watcher per beacon; add keepers freely.** Instances do not coordinate. Duplicate submissions fail
  without being charged, but add RPC load.
- **Watch the logs.** `Proof submitted` carries the round and transaction ID; `Request completed` the request ID and
  transaction ID; both include the `confirmedRound`. `Proof failed` and `Request failed` retry after 2, 4 … 64
  rounds and carry the failing app's [ARC-65](https://arc.algorand.foundation/ARCs/arc-0065) error as `code` when it
  logged one (the beacon's codes are listed in the [README](../README.md#errors)). A request that keeps failing
  usually means its requester's `fulfillRandomness` callback rejects, its refund fails, or it prepaid too little
  fee. `Poll failed` indicates a poll-level failure, such as an RPC or box read error. Polling backs off
  exponentially (2 s up to a minute) and logs `Polling recovered` after a successful poll.
- **Route health warnings to your alerting system.** Health events include `beaconAppId` and an `issue` field.
  They log once on entering a condition or changing its severity, then `Beacon health condition cleared` when it
  disappears. Restarting the daemon reports active conditions again. Repeated request and polling failures retain
  their existing backoff logs. Configure alerts for the events below; log emission alone does not deliver a page.
- **Fees.** The watcher caps proof fees at the round's prepaid `proofFees` and is reimbursed the proof's cost at the
  minimum fee (`(2 + op-ups) × minimum fee`); in `both` mode, grouping a proof with its fulfillments needs fewer
  op-ups. The keeper caps fulfillment fees at `request.costs.fees - request.proofFee`, which a successful call pays
  back. Fees above the minimum, paid during congestion, are not reimbursed. Congestion or a higher protocol
  minimum may prevent submission within those caps. Hosting and node-service costs are additional.
  Cancellation fees are paid by whoever invokes the requester app's expiry method; the daemon has no cancellation budget.
- **Downtime.** The watcher proves at ages 0–990 rounds regardless of the cancellation timeout; once a round is
  proven, fulfillment has no deadline. Use round counts, not a fixed wall-clock estimate. Failed callbacks,
  insufficient fee budgets, and refund failures leave requests pending. Requests of unproven rounds must be expired
  through the requester app; the daemon does not do this for them.
- **Capacity.** The default 128 pending requests are shared by every app. There is no admission control or
  per-app quota; long-lived or failing requests can monopolize capacity. Box reads scale with new requests and
  proofs rather than with capacity, but a burst still costs about four RPC calls per transaction group sent.
- **Upgrading the daemon** is a rebuild and restart; SIGTERM lets the current poll finish, and a second signal
  exits immediately. The supplied deployer makes TestNet/MainNet contracts immutable; verify your deployment's
  settings as described in the [beacon README](../README.md).

| Event / issue                                     | Operator action                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `balance`                                         | Spendable relayer balance is below 0.1 ALGO. Fund the configured signer to cover fees up front.                                                                                |
| `capacity`                                        | All pending slots are occupied. Investigate failing callbacks and expire eligible requests through their requester apps.                                                       |
| `paused`                                          | Confirm the pause is intentional; pending requests are still served.                                                                                                           |
| `request:<id>` — aging                            | At least half the smaller of the cancellation timeout and the 991-round seed-window cutoff has elapsed (rounded down, minimum age 1). Investigate proof submission or expiry.  |
| `request:<id>` — can be cancelled                 | Cancellation is eligible because the round is unproven; proof attempts continue while the seed is readable. Use the requester app's expiry method if cancellation is intended. |
| `request:<id>` — cannot be served                 | The seed-window cutoff has been reached unproven. Use the requester's expiry method once the round exceeds `expiryAfterRound`.                                                 |
| `request:<id>` — callback failing                 | The round is proven, so the request can no longer be cancelled. Fix the requester's callback or fee budget; only fulfillment settles it.                                       |
| `Proof failed` / `Request failed` / `Poll failed` | Inspect the round or request ID, attempt, and error. Repair key/requester/funding issues or restore RPC connectivity; watch for success or `Polling recovered`.                |

Also monitor service/process availability externally: a stopped process cannot report its own failure. Health
checks occur once per block and may be delayed by RPC retries/backoff; these logs are not an uptime guarantee.

## Compatibility and remaining limitations

Use the daemon with the updated beacon and requester apps as one coordinated deployment. `cancelRequest` now
returns the full refund amount and only accepts calls from the requester app. Both fulfillment deposits and
cancellation refunds go to that app for separate user claims. Existing deployments retain their old behavior.
See [migration notes](../README.md) before switching app IDs or rebuilding clients.

Proving and fulfillment are permissionless on the updated contract. Another relayer may submit first and receive
the prepaid fee; a subsequent attempt fails without paying the reward again. Existing beacons with
`completeRequest` require a new deployment, and this daemon does not serve them.

A closed user account no longer prevents settlement. A broken or deleted requester app can still strand its own
requests, and the daemon does not repair app balances or execute arbitrary application-specific expiry methods.
Remaining release and deployment checks are tracked in the [production readiness review](../PRODUCTION_READINESS.md).

## Development

```bash
pnpm run daemon:test         # decision logic and config validation (node:test)
pnpm run daemon:check-types
pnpm run generate-keypair
pnpm run format
```

After building the beacon and daemon, run `pnpm run test:e2e` from the beacon package directory. Its fresh-app
LocalNet suite starts this compiled daemon, verifies a real callback/VRF-derived output, and tests restart, HTTP 503
recovery, callback rollback, capacity, health warning/clear events, and a split watcher/keeper pair. The RPC fault proxy affects only the test daemon.
The `test-fixtures/RejectingCaller` contract is deliberately unsafe and must never be used as a real requester.
The casino monorepo's root `npm run e2e` is a separate deployment helper that verifies a settled bet's VRF proof.
