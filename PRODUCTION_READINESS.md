# Production readiness review

Reviewed 2026-10-01 against casino-monorepo commit `d4fe79a`. Scope: beacon contract, inherited roles, example
requester, deployment scripts, daemon, tests, service templates, and the casino's fulfillment/expiry integration.
The reviewed P1/P2 fixes, release regression tests, and daemon health logging are now implemented, with unit and
fresh-app LocalNet checks. Standalone packaging and clean-install automation are also implemented. Production-
environment validation remains; existing on-chain deployments are not changed by these source edits.

**Verdict: suitable for development and LocalNet integration, not ready for production funds.** Real AVM proof
verification and a complete daemon-driven bet worked in the original review. The P1 fixes now also pass
fresh-app LocalNet settlement and refund checks. Remaining operational and release work prevents
a production-ready verdict. Upstreaming a clearly marked development version is a separate decision from a production release.

## Findings, in priority order

### Round proofs, keepers, and per-request randomness (2026-10-04)

`completeRequest` is split into `submitProof(round, proof)`, which verifies one proof per round and stores the
output in a round box, and permissionless `fulfillRequest(requestId)`, which needs no key. Each request receives
`sha256(vrfOutput ‖ beaconAppId ‖ requestId ‖ requesterAppId ‖ requesterAddress)`, with every input fixed at
creation (a fulfillment-order counter was rejected because relayers could permute outcomes). Proofs are rejected
for rounds without requests or already proven. Cancellation is rejected once a round is proven, closing a selective-
expiry hole that already existed for requests sharing a round. Each request deposits a whole round box (84,200
microALGO total, refunded) and prepays 14 × the minimum fee: up to 10 for the round's proof and 4 for its fulfiller.
The prover is reimbursed the proof's measured cost, `(2 + op-ups) × minimum fee`. Grouped fulfillments lend their
opcode budget, so a proof with 8 grouped fulfillments costs 2 fees instead of 10. Requests get the unspent proof
fees back pro rata with their deposit; integer division can leave the beacon a few microALGO of dust per round.

The daemon now wakes on each block rather than polling. A `ROLE` (watcher, keeper, both) separates the VRF key from
callback execution. Proofs use `FirstValid = last round + 1`, so they land at target + 1 instead of target + 2.
In `both` mode, fulfillments are grouped with the proof. Same-round requests, the target + 1 landing, distinct
outputs, exact deposit/fee accounting, rejected expiry after proof, and a split watcher/keeper pair are covered on
LocalNet. Grouped delivery on a network with real block times, rather than dev-mode LocalNet, is not yet exercised.
A requester whose callback always fails now holds its proven request and capacity slot permanently.

The default capacity is now 128. Each block, the daemon reads only global state and its balance. It reads request
boxes once, and re-reads unproven rounds only when the new `totalProofs` counter changes; LocalNet verifies zero box
reads on idle blocks. Fulfillments go out in groups of up to 16, sending each alone if any callback fails. Every
beacon failure is an ARC-65 `ERR:<code>` (see the README's error table), and the daemon logs the code. A second
`submitProof` in one group can exhaust pooled opcode budget; the daemon never sends one, and the README documents the
limit.

### Timeout planning and round arithmetic

The daemon now attempts completion throughout its seed-access window, including after cancellation becomes
eligible. This matches the contract's existing behavior and fixes the empty completion window with a one-round
timeout. Health logs distinguish cancellation eligibility from a seed that can no longer be served.
Future-round validation and cancellation eligibility compare round differences, avoiding `uint64` overflow
with large configured limits. `createdAt` remains in request storage so pending requests expose their creation
round without a separate transaction lookup; its 3,200 microALGO box deposit contribution is refundable.

### Permissionless completion

Completion (now `submitProof` plus `fulfillRequest`) accepts any relayer with a valid proof for the stored target
seed and public key. The successful submitting account receives the prepaid fee; a competing relayer may complete
first. Administrative
methods remain restricted. The daemon retains `MANAGER_MNEMONIC` as its signer configuration name but no longer
requires the manager role or suspends on role changes. Manager renunciation does not disable completion.
Existing immutable manager-only deployments require a new beacon to enable this behavior. The key holder can
still withhold proofs; independent relaying only improves delivery once a proof is available.

### Fixed P1 — Third-party cancellation stranded requester funds

`cancelRequest` now requires `Global.callerApplicationId === request.requesterAppId`. The daemon no longer
cancels. Anyone can trigger the casino's `expireBet` or the example's `expireRequest`, but their app performs the
beacon cancellation and updates its own state atomically.

Regression checks reject direct account and unrelated-app cancellation, enforce the stale boundary, and prove
that an unrelated user can expire a casino bet and release its reserved maximum payout without bypassing the casino.

### Fixed P1 — Closed user accounts blocked refunds and capacity recovery

Completion refunds the box deposit to the requester app; cancellation returns the full deposit plus prepaid fees
to that app and returns the amount as `uint64`. Request storage is released before the deposit refund. Users claim
separately, so an unfunded/closed user account cannot block beacon settlement. Failed claims remain retryable.

The casino records both box deposits in `Bet.boxMbr`, includes all unused fees (including overpayment) after
expiry, and sends refundable ALGO and any ASA payout to the player's selected claim receiver. The example has
an authenticated `claim(receiver)` with the same separation between settlement and user payment.

LocalNet checks close the user's account before completion and cancellation, then verify request deletion,
pending-count recovery, exact app/recipient balances, casino liabilities, failed-claim rollback, redirected claims,
and double-claim rejection.

Requester apps must still remain funded and available and implement a working expiry path. Deleted or malicious
requester apps can still strand their own requests; app-only cancellation does not provide universal orphan cleanup.
This is an explicit integration/liveness constraint, not a guarantee that arbitrary requester code is safe.

### Fixed P1 — The example accepted forged callbacks and misdirected deposits

The example now validates deposit sender/receiver, close/rekey fields, and amount; it authenticates callback app,
request ID, and requester, and rejects replays. All inner fees are pooled. It provides expiry and separate refund
claims. To keep the example small it permits only one outstanding request/refund at a time; production concurrent
integrations should use funded per-request storage. Its next-round target remains demonstration-only.

Unit and LocalNet checks cover forged callbacks, wrong request IDs/addresses, replays, malformed deposits,
unauthorized/double claims, and reuse after a successful claim.

### Migration required

This changes `cancelRequest(uint64)void` to `cancelRequest(uint64)uint64` and changes refund destinations.
Rebuild generated clients and deploy a compatible beacon/requester pair. The supplied casino is immutable and
needs a new deployment; old requesters must not be pointed at or run under the new beacon implementation.
Settle and claim the old deployment separately before migration. These source fixes do not repair previously
stranded bets on immutable old deployments.

### Fixed P2 — Deployment failures reported success to automation

[`smart_contracts/index.ts`](smart_contracts/index.ts) now exits nonzero for deployer exceptions, discovery errors,
and unknown contract filters. Creation inputs are checked before constructing the network client: a correctly
encoded 32-byte public key and positive integers bounded to `uint64`. Unset numeric values use defaults; empty
values are rejected.

After deployment, the public key and all three stored limits are compared with the requested values. Mismatches
identify the app and fields and fail rather than imply that new creation settings were applied. This post-deploy
check does not roll back a code update that already succeeded.

Five deployment unit/CLI checks cover invalid inputs, uint64 endpoints, missing/mismatched state, repeat-deploy
funding, and actual exit codes. A fresh-account LocalNet CLI scenario verifies creation and initial funding,
successful reuse of the same app without extra funding, and exit code 1 for changed key/limits while stored
configuration remains unchanged. The complete beacon suites now pass 10 unit tests and 8 LocalNet scenarios.

### Fixed P2 — Missing release regression coverage

The Vitest discovery defect is fixed: its config now includes only `smart_contracts/**/*.spec.ts`, so the default
beacon `pnpm test` no longer collects the daemon's `node:test` file. The daemon retains its separate runner.
The casino now exposes `test:e2e`, with those LocalNet tests excluded from ordinary unit runs.

Some old unit tests still duplicate request creation via spies and mock `vrfVerify`. Real-AVM regression suites now
cover the P1 paths, invalid proofs, role transfers/renunciation, zero-address rejection, pause/unpause, fulfillment
while paused, immutable update rejection, insufficient completion fees, and exact seed transaction bounds.

A beacon-only LocalNet scenario runs the compiled daemon against fresh apps through an isolated HTTP proxy. It
fills all five request slots of a capacity-5 beacon, completes four requests in one poll while a rejecting callback remains
pending, and verifies capacity recovery, rollback, correct VRF output after restart, HTTP 503 outage/recovery, and
health warning/clear events. Its deliberately rejecting requester is a test fixture, not a production integration.
Sustained load and real network congestion remain environment-level release checks.

### Fixed P2 — Startup validation overstated what it guaranteed

[`loadConfig`](daemon/src/config.ts) now checks the full 64-byte VRF keypair: it derives the public key from the
secret seed using the installed VRF library and compares it with the stored public-key half. Malformed base64 and
inconsistent keypairs fail before network access. Startup checks the key against on-chain state; the funded signer
does not need the manager role.

`POLL_INTERVAL` is bounded to `100–2147483647` ms, app IDs to positive `uint64`, and ports to `1–65535`.
Algod URLs must be absolute HTTP(S), without credentials, query, or fragment. The daemon constructs an explicit
algod-only client, preserving SDK retries and URL ports when no override is supplied. Tokenless custom endpoints
work with an omitted token; Indexer and KMD are not constructed.

Regression checks cover numeric boundaries, malformed endpoints/keys, corruption of either key half, a real VRF
proof round trip, SDK request URL/token handling, absence of KMD/Indexer, and a nonzero daemon exit for a corrupted
key. The existing `node:test` runner is reused without new dependencies.

### Fixed P2 — Daemon health was only checked at startup

Each poll now checks spendable balance, capacity, pause state, and request age. Health warnings are
logged on condition/severity transitions, with a clear event when they disappear; memory is bounded by active
conditions and current requests. Fulfillment continues independently of manager role changes.
Existing request-error and RPC-error backoff logs remain.

The [operations guide](daemon/README.md#operating-it) maps these events to operator actions. Actual alert delivery
and external process monitoring must be configured at deployment; emitting logs does not page an operator.

## Protocol constraints to retain in the documentation

- **Timeout is cancellation eligibility.** There is no expiry check in `submitProof` or `fulfillRequest`, and a
  proven round's requests cannot be cancelled at all. If integrators need a strict fulfillment deadline, enforce it
  consistently in the contract and daemon before release.
- **Per-request derivation, shared VRF input.** Requests on a round share one VRF output; the beacon binds it to
  the request ID, requester app/address, and beacon app ID. Every value on a round is public once its proof is
  posted, before callbacks run.
- **Future is not a quantified security margin.** Creation allows the next round; the example requests exactly
  that. Select and document a minimum delay appropriate to the application. See
  [Algorand's randomness guidance](https://dev.algorand.co/concepts/protocol/randomness/).
- **Seed access depends on transaction bounds.** `LastValid - 1002 < targetRound < FirstValid`; the daemon's
  `FirstValid = last round + 1` and 10-round window permit proofs at ages 0–990. Cancellation eligibility does not
  stop the daemon, and expiry remains owned by the requester app. This is not a universal 990-round contract
  deadline, and fulfillment of a proven round has none. See the
  [AVM block reference](https://dev.algorand.co/reference/algorand-teal/opcodes/#block).
- **Immutability comes from deployment.** The provided deployer disables updates outside LocalNet. A custom
  deployer can set `TMPL_UPDATABLE` differently. The manager can also renounce its administrative role while
  requests exist, without disabling proof relaying, and delete the app when it has no pending requests.

## Standalone upstream package

This directory is now the proposed standalone repository root. It owns a pnpm lockfile and one package for the contract and daemon;
declares its direct tooling dependencies; pins the VRF implementation to commit
`92c8b60617feb17f5327f17d47020595eb025818`; ignores secrets and generated clients; and uses standalone service
paths and commands. A clean install no longer depends on the casino workspace. The pinned VRF source still runs
`prepare` through pnpm 12.6; its exact immutable archive is the only dependency allowed to execute a build during
installation. Oxlint and oxfmt replace ESLint and Prettier.

The CI workflow builds the contract and daemon, runs both unit suites, checks types/lint/format and service files,
then runs the LocalNet suite. A separate manual workflow deploys an immutable TestNet app using protected
environment secrets. Upstreaming should replace the existing repository's `projects/` layout with this root rather
than layering this package under it.

The package name no longer uses the casino namespace and the package remains private. No license has been selected;
add the chosen LICENSE and matching package metadata before describing the project as a licensed reusable release.

## Verification performed

Environment: Node 22.14.0, pnpm 12.6.0, AlgoKit CLI 2.10.2, Puya TS 1.3.1 / Puya 5.10.1, AlgoKit Utils 9.2.2,
Algorand TypeScript Testing 1.2.0, Vitest 4.1.11. Both the existing checkout and an isolated empty-cache install
were tested against an already-running LocalNet. These are tested versions, not a claim that every declared minimum
version works.

P1/P2 verification uses newly compiled contracts and fresh LocalNet apps. Beacon commands run from this standalone
package root; casino integration commands run from the casino monorepo root:

| Check                                   | Result                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| Builds: beacon, daemon, casino          | Pass; clients and tracked casino artifacts regenerated                             |
| Beacon `pnpm test`                      | Pass: 10 tests, including authorization and deployment input/exit-code checks      |
| Casino `npm test`                       | Pass: 13 tests, including deposit/expiry refund accounting                         |
| Daemon `pnpm run daemon:test`           | Pass: 8 tests; request planning, startup validation, and algod-only configuration  |
| Beacon `test:e2e`                       | Pass: 8 scenarios, including a full five-request batch and daemon recovery/health  |
| Casino `test:e2e`                       | Pass: 2 LocalNet scenarios: closed-user completion and expiry, then exact claims   |
| `check-types` in beacon, daemon, casino | Pass                                                                               |
| Empty-store `pnpm install`              | Pass with network access over HTTPS and SSH disabled                               |
| Standalone `pnpm audit --prod`          | No reported production advisories                                                  |
| Standalone install audit                | 2 low-severity entries: testing library and transitive `elliptic`; no fix reported |

Lint passes in both contract packages (the beacon retains 21 accessibility-modifier warnings). Casino unit tests
exit zero with all 13 passing, but the combined run still emitted a Vitest shutdown timeout warning. A focused
rerun with the default and `hanging-process` reporters exited cleanly and identified no hanging resource; the
intermittent tooling warning remains unresolved. No shutdown-timeout suppression or test-runner change was added.

The current beacon suite runs the daemon end to end against fresh beacon/requester deployments and verifies
restart and RPC recovery. The casino suite separately uses fresh apps and directly exercises both settlement
paths. The original monorepo full-stack helper was not rerun against the user's existing local apps because the
ABI/refund changes require coordinated new deployments.

The advisory entries concern the unit-testing dependency, not evidence of a flaw in the beacon's VRF WASM library.
The advisory is [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84).
Pnpm audit does not independently audit the Git-sourced VRF implementation.

Not exercised: TestNet/MainNet deployment or soak testing, sustained load/network congestion beyond the five-request
LocalNet smoke test, service installation/reboot, real operator alert delivery, or a full cryptographic/security
audit. The LocalNet tests were run against freshly deployed applications from this source. No production deployment
or GitHub publication was performed.
