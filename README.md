# Randomness Beacon

An on-chain VRF randomness oracle for Algorand applications. An app requests randomness for a future round. Once
that round is committed, the beacon's operator proves its block seed with the beacon's VRF key (`submitProof`); the
contract verifies it once with `vrf_verify` and stores the round's output. Anyone can then deliver each request
(`fulfillRequest`), which passes the app 32 bytes of randomness derived from that output and the request. The
[daemon](daemon/README.md) does both, delivering in the block right after the target round.

**Status: development preview; not ready for production funds.** The three P1 findings are fixed in this source:
requester-app cancellation, app-held refunds, and authenticated example requests/callbacks. Remaining release
work is tracked in the [production readiness review](PRODUCTION_READINESS.md).

**Breaking changes:** `completeRequest` is replaced by `submitProof(uint64,byte[80])void` (per round) and
`fulfillRequest(uint64)void` (per request). The callback is now `fulfillRandomness(uint64,address,byte[32])void`,
`RequestFulfilled` carries `randomness` instead of `vrfOutput`, and the new `RoundProven` event carries the round's
`vrfOutput`. `getCosts()` keeps its shape with new values, cancellation is rejected once a round is proven, and
the request box gains `proofFee`. Earlier, `cancelRequest(uint64)void` became `cancelRequest(uint64)uint64`, and
refunds go to the requester app rather than the user. Deploy the updated beacon and compatible requester apps
(including the casino's callback) together; rebuild generated clients and the daemon. Existing immutable
deployments are unchanged. Settle/claim old requests through their original applications before moving to new app
IDs; do not update a live beacon underneath old requesters.

## Trust and randomness

- **One operator.** For a fixed key and seed, the verified output is deterministic. The operator can learn a
  round's output before publishing it, or withhold the round's proof. Fulfillment order does not affect any output.
- **Permissionless relaying.** Anyone can submit a valid round proof and receives the round's prepaid proof fees;
  anyone can fulfill a request of a proven round and receives its fulfillment fee. A faster relayer may claim
  either first. A round is proven once and a deleted request cannot be fulfilled again. Relaying does not prevent
  the VRF key holder from withholding proofs. Deploy a new beacon to enable this behavior.
- **Commit before the seed is known.** The contract only requires a future round; it does not enforce a security
  margin beyond that. Integrators must choose a delay appropriate to their threat model and commit the request's
  terms before the target seed is knowable. See [Algorand's randomness guidance](https://dev.algorand.co/concepts/protocol/randomness/).
- **Per-request randomness.** Each request receives
  `sha256(vrfOutput ‖ itob(beaconAppId) ‖ itob(requestId) ‖ itob(requesterAppId) ‖ requesterAddress)`. Every input
  is fixed when the request is created, so requests on the same round get distinct values and no relayer can choose
  which request gets which. Once the round's proof is posted, anyone can compute every value on that round. This does
  not mitigate withholding or an insufficient target-round delay.
- **Proven requests cannot be cancelled.** Because a proven round's outcomes are public, `cancelRequest` rejects its
  requests: they can only be fulfilled, so nobody can discard an unwanted outcome through expiry. A callback that
  always fails therefore keeps its request, and a capacity slot, forever. As with Chainlink VRF, `fulfillRandomness`
  must not revert.
- **Withholding needs an application policy.** The beacon offers cancellation eligibility, not guaranteed delivery
  or automatic compensation. The casino awards its maximum payout through permissionless `expireBet`; only the
  casino app can cancel its own beacon request.

## Roles

| Role          | Who                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------- |
| Requester app | The application that calls `createRequest` (plain accounts cannot request).                   |
| Requester     | The user the request is on behalf of; claims refunds from the requester app.                  |
| Prover        | Any account with a valid round proof (the daemon's watcher); receives the round's proof fees. |
| Keeper        | Any account; fulfills requests of proven rounds and receives their fulfillment fees.          |
| Manager       | Creator by default; controls manager transfer, app updates, and deletion.                     |
| Pauser        | Creator by default; can `pause` / `unpause` new requests.                                     |

## Request lifecycle

1. The requester app calls `createRequest(requesterAddress, round, costsPayment)` in an inner transaction, paying
   at least `getCosts()` (`fees + boxMbr`) to the beacon. `round` must be in
   `(Global.round, Global.round + maxFutureRounds]`. It returns a unique `requestId` and emits `RequestCreated`.
2. Once the target round is committed, any relayer calls `submitProof(round, proof)` with an 80-byte proof of its
   seed. It rejects rounds without pending requests and rounds already proven, verifies the proof, stores the
   round's VRF output, increments the global `totalProofs`, reimburses the sender what proving cost, and emits
   `RoundProven`. Verification uses about 5,800 opcodes of pooled budget. The beacon creates only the op-up calls
   the group still lacks (up to 8), and pays `(2 + op-ups) × minimum fee`, never more than the round prepaid.
   Grouping the proof ahead of its round's fulfillments lends it their budget: each one saves an op-up, and 8 or
   more save them all. A second `submitProof` in the same group can run out of budget, so put one per group.
3. Any account then calls `fulfillRequest(requestId)`. The beacon derives the request's randomness, calls
   `fulfillRandomness(requestId, requesterAddress, randomness)` on the requester app, pays the fulfillment fee
   (`fees - proofFee`) to the sender, deletes the request (and the round's box with its last request), refunds
   `boxMbr` plus the request's pro rata share of unspent proof fees to the requester app, and emits
   `RequestFulfilled`. A failing callback or refund rolls back the
   fulfillment and leaves the request pending; the round stays proven.
4. Once `Global.round > round + staleRequestTimeout`, and **only while the round is unproven**, the requester app
   (and only it) can call `cancelRequest(requestId)`. It refunds the full `fees + boxMbr` to that app, emits
   `RequestCancelled`, deletes the request, and returns the refund amount. There is no cancellation fee rebate;
   the outer caller funds the transaction group. Integrators should expose a permissionless expiry method that
   cancels and settles their own state atomically. The daemon never cancels requests.
5. The requester app holds user refunds for a separate authenticated claim. Fulfillment and expiry make no
   payment to the user, so closing a user account does not block them. A failed claim can be retried using a
   suitable receiver without recreating a pending beacon request.

The timeout enables cancellation of unproven requests; it does **not** forbid proving. With a short timeout, a
relayer can still prove a round whose requests have not been cancelled while its seed remains readable, after
which they can only be fulfilled. There is no automatic on-chain expiry: somebody must submit a successful
transaction.

## Integrating

Authenticate the callback and check your own pending request, requester, and settlement state:

```ts
public fulfillRandomness(requestId: uint64, requesterAddress: arc4.Address, output: bytes<32>): void {
  loggedAssert(Global.callerApplicationId === this.beaconApp.value.id, 'unauthorizedCallback')
  // Validate requestId and requesterAddress against stored pending state before using output.
}
```

[`contracts/example-caller.algo.ts`](smart_contracts/randomness_beacon/contracts/example-caller.algo.ts) is a
small example with payment validation, authenticated fulfillment, permissionless `expireRequest()`, and
`claim(receiver)` restricted to the requester. It permits one request at a time: complete or expire it, then claim
before creating the next. Its next-round target is for demonstration, not a production security-delay policy.
The casino monorepo's `packages/contracts/smart_contracts/dice-casino/contract.algo.ts` shows concurrent bet
accounting and claims; `claim` sends both the ASA payout and refundable ALGO to the player's chosen receiver.

- **Costs.** Simulate the read-only `getCosts()` method to build the payment. With the current layout, `boxMbr` is
  84,200 microALGO: a 40,900 request box (16-byte key, 80-byte value) plus a whole 43,300 round box (14-byte key,
  88-byte value). Every request deposits a full round box and gets it all back; the round's last request frees the
  one actually used. `fees` is 14 × the minimum transaction fee: up to 10 for the round's proof and 4 for the
  fulfillment. The proof share is an upper bound: requests sharing a round split the proof's actual cost, and each
  gets its unspent share back with its deposit. At a 1,000 microALGO minimum, the deposit plus prepaid fees is
  98,200 microALGO. Request-creation transaction fees are extra. If your callback needs
  additional inner transactions or opcode budget, prepay extra: everything above `boxMbr` becomes the request's
  `fees`, and everything beyond the proof fee is the fulfillment fee cap. Simulate the full integration.
- **Refund accounting.** Quote `getCosts().boxMbr` when creating a request and credit it to the user's later claim
  after fulfillment. The same refund payment also carries the request's unspent share of its proof fee (at most
  `proofFee`, 10,000 microALGO at current fees). It arrives after your callback returns, so pass it on or keep it as
  your app's accounting allows. On cancellation, use the returned full refund amount, including any extra prepaid fees.
  Keep the requester app funded and available until all requests and claims are resolved; do not forward refunds
  to users inside the callback/expiry method. A failing user payment must only affect their separate claim.
- **Using the output.** Derive values deterministically and account for modulo bias; the casino's first-eight-byte
  `uint64 % 100` mapping has a small bias. For more than 32 bytes, hash the randomness with a counter.
- **Verifying.** Recompute `vrf_verify(publicKey, seed(round), proof)` off-chain from `submitProof`'s arguments and
  compare it with `RoundProven.vrfOutput`, then recompute each request's randomness with the formula above and
  compare it with `RequestFulfilled.randomness`. Take the round from the request or `RequestCreated` event and the
  public key from the beacon's global state. Persist the request/event data: fulfilled and cancelled request
  boxes, and finished round boxes, are deleted.

## Errors

Every beacon failure logs an [ARC-65](https://arc.algorand.foundation/ARCs/arc-0065) error, `ERR:<code>`, before
failing; algod returns it in the failed call's logs, and its error details quote it. Requester apps that call the
beacon in inner transactions see the same codes.

| Code                                                                | Raised by                                      | Meaning                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `Paused`                                                            | `createRequest`                                | New requests are paused                                      |
| `CapacityExhausted`                                                 | `createRequest`                                | `maxPendingRequests` requests are already pending            |
| `RoundNotFuture`                                                    | `createRequest`                                | The target round is not after the current round              |
| `RoundTooFar`                                                       | `createRequest`                                | The target round is more than `maxFutureRounds` ahead        |
| `CallerNotApp`                                                      | `createRequest`                                | Called by an account rather than an application              |
| `InvalidPayment`                                                    | `createRequest`                                | The payment is not to the beacon or is below `getCosts()`    |
| `UnknownRequest`                                                    | `fulfillRequest`, `cancelRequest`              | No pending request has this ID                               |
| `NotRequesterApp`                                                   | `cancelRequest`                                | The caller is not the app that created the request           |
| `NotStale`                                                          | `cancelRequest`                                | `staleRequestTimeout` has not elapsed since the target round |
| `RoundProven`                                                       | `submitProof`, `cancelRequest`                 | The round is already proven                                  |
| `RoundNotProven`                                                    | `fulfillRequest`                               | The request's round has no proof yet                         |
| `NoRequestsForRound`                                                | `submitProof`                                  | No pending request targets this round                        |
| `SeedUnavailable`                                                   | `submitProof`                                  | The round is outside `LastValid - 1002 < round < FirstValid` |
| `InvalidProof`                                                      | `submitProof`                                  | The proof does not verify against the seed and public key    |
| `NotManager`                                                        | manager methods, `updateApplication`, deletion | The sender is not the manager                                |
| `NotPauser`                                                         | `pause`, `unpause`, `updatePauser`             | The sender is not the pauser                                 |
| `ZeroAddress`                                                       | `updateManager`, `updatePauser`                | The new role holder is the zero address                      |
| `NotUpdatable`                                                      | `updateApplication`                            | The deployment was made immutable                            |
| `RequestsPending`                                                   | app deletion                                   | Requests are still pending                                   |
| `ZeroMaxPendingRequests`, `ZeroMaxFutureRounds`, `ZeroStaleTimeout` | creation                                       | A limit was set to zero                                      |

Router-level failures (unknown method, malformed arguments) and AVM failures such as insufficient fees or opcode
budget are not ARC-65 errors.

## Configuration

Set at creation; there are no setters in this contract:

| Parameter             | Deploy env (default)           | Meaning                                                      |
| --------------------- | ------------------------------ | ------------------------------------------------------------ |
| `publicKey`           | `VRF_KEYPAIR_PUBLIC_KEY`       | Base64 32-byte VRF public key                                |
| `maxPendingRequests`  | `MAX_PENDING_REQUESTS` (128)   | Open requests allowed across all requester apps              |
| `maxFutureRounds`     | `MAX_FUTURE_ROUNDS` (100)      | Maximum target-round distance from the creation round        |
| `staleRequestTimeout` | `STALE_REQUEST_TIMEOUT` (1000) | Rounds after the target before cancellation becomes eligible |

The deployer validates the public key's base64 encoding and requires numeric parameters in `1–18446744073709551615`
before connecting to the network. Omit a numeric environment variable to use its default; an empty value is invalid.
There is no minimum security delay, timeout ceiling,
or per-requester capacity limit. A long timeout can keep requests occupying capacity after their seeds age out.

### Seed availability

The AVM `block` opcode requires `LastValid - 1002 < targetRound < FirstValid`, using `submitProof`'s validity
bounds. See the [opcode reference](https://dev.algorand.co/reference/algorand-teal/opcodes/#block). The daemon
uses `FirstValid = last committed round + 1` and a 10-round validity window, so it proves a round from the moment it
is committed (age 0, landing in the next block) through age 990, including rounds whose requests are eligible for
cancellation. Age 991 is a limit of this daemon's transaction window, not a universal on-chain expiry. Shorter
windows allow later attempts but less time for inclusion. Fulfillment does not read the seed, so it has no such
limit once the round is proven.

### Upgradability

`updateApplication` requires the manager and AlgoKit's deploy-time `TMPL_UPDATABLE` flag.
[`deploy-config.ts`](smart_contracts/randomness_beacon/deploy-config.ts) sets it **true on LocalNet** and **false on
other networks**, including TestNet/MainNet. Code changes update LocalNet apps in place; other networks append a
new app. Immutability is a property of those deployment settings, not something enforced by the network name
inside the contract. A custom deployment can enable updates, so verify the deployed program.

The manager can transfer its role with `updateManager`, permanently give it up with `deleteManager`, and delete
the app when no requests are pending (remaining funds go to the manager). Deleting the manager disables manager-only
administration; proof relaying and new requests remain possible unless creation is paused. The pauser can transfer
its role and stop new requests; existing requests can still be proven, fulfilled, or cancelled.

## Building and deploying this checkout

Install Node.js 22.12+, pnpm 12.6, and the AlgoKit CLI. This directory is a standalone pnpm project (one package for the
contract and daemon); run these commands from its root:

```bash
pnpm install --frozen-lockfile
pnpm run build:all
pnpm run generate-keypair
```

The daemon's declared runtime minimum is Node.js 22.9. The VRF dependency is pinned to an immutable Git commit,
but its install runs `prepare` through pnpm. Back up the generated secret key before deploying; the public key goes
into the beacon configuration and the secret key goes into the daemon configuration.

For a direct deployment:

```bash
cp .env.example .env
# Set DEPLOYER_MNEMONIC, VRF_KEYPAIR_PUBLIC_KEY, and matching algod/indexer settings in .env.
pnpm run deploy:ci
```

The deployer must be funded; it becomes manager and pauser. A newly created beacon receives 1 ALGO from it.
Deployment lookup uses Indexer and is idempotent by creator/app name. The deployer checks the resulting app's public
key and numeric settings against the requested configuration. A mismatch, deployment error, or unknown contract
name makes `deploy:ci` exit nonzero. Changing creation arguments alone does not reconfigure an existing app: use
its original settings or deploy a new beacon. The configuration check happens after deployment and does not roll
back a code update that already succeeded.

The manual `Deploy TestNet` GitHub Actions workflow performs the same immutable TestNet deployment using the
`contract-testnet` environment's `DEPLOYER_MNEMONIC` and `VRF_KEYPAIR_PUBLIC_KEY` secrets. It does not start a daemon.
See [daemon setup](daemon/README.md) to operate one.

## Remaining limitations

- Requester apps must expose a working expiry path, remain available/funded, and accept their callbacks. A broken,
  deleted, or malicious requester can still occupy pending capacity, permanently once its round is proven. This
  permissionless beacon has no admission control or per-app quota.
- Claims require the original user to authorize them and a receiver able to accept the payment. A closed user
  account may need funding for the claim transaction; this no longer blocks beacon settlement or capacity recovery.
- TestNet soak testing, service installation/reboot checks, operator alert delivery, and an independent security
  review remain in the [production readiness review](PRODUCTION_READINESS.md). The LocalNet checks are not a
  production audit.

## Development checks

From this repository root:

```bash
pnpm run build:all
pnpm run test:all
pnpm run check-types:all
pnpm run lint
pnpm run format:check
algokit localnet start
pnpm run test:e2e
```

Vitest discovery is scoped to `smart_contracts`; the daemon uses its separate `node:test` command. Some contract
unit tests still mock `vrfVerify` and duplicate creation logic. The LocalNet suite exercises the real AVM, including
invalid proofs, cancellation authorization, closed-account settlement, example payment/callback rejection, and claims.
It also checks role transfers, pause/unpause, immutable update rejection, proof fee/seed bounds, callback rollback,
and two same-round requests sharing one proof that lands in the next block, getting distinct randomness, and
refusing expiry once proven. A fresh-app daemon scenario fills all five request slots of a capacity-5 beacon, delivers four while
a rejecting callback remains pending, then verifies fulfillment after restart and an HTTP 503 outage. It also checks
health logs for low balance, capacity, and aging requests, continued relaying after manager renunciation, and a
watcher with the key plus a keeper without it.
It does not use the casino's deployment configuration.
The deliberately rejecting contract under `test-fixtures` is for LocalNet tests only, never a real requester.
The casino monorepo has separate integration checks for its completion/expiry and exact refund accounting; old
immutable casino deployments must be replaced to use this version.
