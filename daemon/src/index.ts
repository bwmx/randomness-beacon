import { AlgorandClient, microAlgo } from '@algorandfoundation/algokit-utils'
import { init as initVrf, prove } from '@bwmx/algorand-vrf-utils-ts'
import { makeBasicAccountTransactionSigner } from 'algosdk'
import { setTimeout as sleep } from 'node:timers/promises'
import { RandomnessBeaconClient, RandomnessRequest, RoundState } from './clients/RandomnessBeaconClient'
import { loadConfig } from './config'
import logger, { describe, errorCode } from './logger'
import { canProve, chunk, MAX_GROUP_SIZE, MAX_SEED_AGE, PROOF_VALIDITY_WINDOW, retryDelay, roundsToCheck } from './plan'

const LOW_BALANCE = microAlgo(100_000)
const SEND = { populateAppCallResources: true, coverAppCallInnerTransactionFees: true, suppressLog: true }
const REQUESTS_PREFIX = Buffer.from('requests')
const isProven = (state?: RoundState) => !!state?.output.some((byte) => byte !== 0)
/** A box deleted between listing and reading it (fulfilled or cancelled meanwhile) reads as absent. */
const absent = (err: unknown) => {
  if ((err as { response?: { status?: number } }).response?.status === 404) return undefined
  throw err
}

type Pending = [requestId: bigint, request: RandomnessRequest]

async function main(signal: AbortSignal) {
  const { algodConfig, beaconAppId, role, manager: relayer, vrfSecretKey, vrfPublicKey } = loadConfig()
  const proves = role !== 'keeper'
  const fulfills = role !== 'watcher'
  const algorand = AlgorandClient.fromConfig({ algodConfig })
  const { algod } = algorand.client
  const beacon = new RandomnessBeaconClient({
    algorand,
    appId: beaconAppId,
    defaultSender: relayer.addr,
    defaultSigner: makeBasicAccountTransactionSigner(relayer),
  })

  // Fail fast on misconfiguration that would otherwise make every transaction fail.
  const state = await beacon.state.global.getAll().catch((err) => {
    throw new Error(`Cannot read beacon ${beaconAppId} from ${algodConfig.server}: ${describe(err)}`)
  })
  if (vrfPublicKey) {
    await initVrf()
    const onChainKey = state.publicKey?.asByteArray()
    if (!onChainKey || !Buffer.from(onChainKey).equals(Buffer.from(vrfPublicKey))) {
      throw new Error(`VRF_PRIVATE_KEY does not match the public key of beacon ${beaconAppId}`)
    }
  }
  const staleTimeout = state.staleRequestTimeout!
  const { balance, minBalance } = await algorand.account.getInformation(relayer.addr)
  const spendable = microAlgo(balance.microAlgo - minBalance.microAlgo)
  logger.info(
    { beaconAppId, role, relayer: relayer.addr.toString(), spendable: spendable.toString(), staleTimeout },
    'Randomness beacon daemon started',
  )

  // Per-round/request retry backoff, so something that keeps failing is not retried (and logged) every block.
  const failures = new Map<string, { count: number; retryAt: bigint }>()
  let health = new Map<string, string>()

  // Boxes are read once: a request box never changes after creation, and a proven round stays proven until its
  // box is deleted. The request set is re-listed only when nextRequestId or totalPendingRequests changes, and
  // unproven past rounds are re-read only when totalProofs does.
  const requests = new Map<bigint, RandomnessRequest>()
  const proven = new Set<bigint>()
  const checkedAt = new Map<bigint, bigint>() // unproven round -> totalProofs when its box was last read
  let listed = ''

  const backingOff = (key: string, lastRound: bigint) => lastRound < (failures.get(key)?.retryAt ?? 0n)
  function failed(key: string, lastRound: bigint, context: Record<string, unknown>, message: string, err: unknown) {
    const count = (failures.get(key)?.count ?? 0) + 1
    const retryAt = lastRound + retryDelay(count)
    failures.set(key, { count, retryAt })
    logger.error({ ...context, attempt: count, retryAt, code: errorCode(err), error: describe(err) }, message)
    logger.debug({ err }, `${message}: details`)
  }

  // Never pay more than the requester prepaid: fulfillRequest pays us exactly its fees minus the proof fee.
  const fulfillCall = ([requestId, request]: Pending) => ({
    args: { requestId },
    maxFee: microAlgo(request.costs.fees - request.proofFee),
  })
  const requestContext = ([requestId, request]: Pending, lastRound: bigint) => ({
    requestId,
    requesterAppId: request.requesterAppId,
    round: request.round,
    lastRound,
  })
  function completed(pending: Pending, lastRound: bigint, txId: string, confirmedRound?: bigint) {
    failures.delete(`request:${pending[0]}`)
    logger.info({ ...requestContext(pending, lastRound), txId, confirmedRound }, 'Request completed')
  }

  async function fulfill(pending: Pending, lastRound: bigint) {
    try {
      const result = await beacon.send.fulfillRequest({ ...fulfillCall(pending), ...SEND })
      completed(pending, lastRound, result.txIds[0], result.confirmation.confirmedRound)
    } catch (err) {
      failed(`request:${pending[0]}`, lastRound, requestContext(pending, lastRound), 'Request failed', err)
    }
  }

  /** Fulfills up to 16 requests in one group; one failing callback fails the group, so then each is sent alone. */
  async function fulfillBatch(batch: Pending[], lastRound: bigint) {
    if (batch.length > 1) {
      const group = beacon.newGroup()
      for (const pending of batch) group.fulfillRequest(fulfillCall(pending))
      try {
        const { txIds, confirmations } = await group.send(SEND)
        batch.forEach((pending, i) => completed(pending, lastRound, txIds[i], confirmations[i].confirmedRound))
        return
      } catch (err) {
        const requestIds = batch.map(([id]) => id)
        logger.debug({ requestIds, lastRound, error: describe(err) }, 'Grouped fulfillment failed; sending each alone')
      }
    }
    await Promise.all(batch.map((pending) => fulfill(pending, lastRound)))
  }

  async function submitProof(round: bigint, waiting: Pending[], lastRound: bigint) {
    const key = `round:${round}`
    if (backingOff(key, lastRound)) return
    const context = { round, pending: waiting.length, lastRound }
    try {
      const { block } = await algod.block(round).do()
      const proofCall = {
        args: { round, proof: prove(vrfSecretKey!, block.header.seed).proof },
        // Never pay more than the round's prepaid proof fees (the sum of its requests' shares), paid back to us.
        maxFee: microAlgo(waiting.reduce((sum, [, request]) => sum + request.proofFee, 0n)),
        // Land in the next block: the AVM reads the seed of a committed round below FirstValid.
        firstValidRound: lastRound + 1n,
        validityWindow: PROOF_VALIDITY_WINDOW,
      }
      if (fulfills) {
        // Fast path: deliver in the proof's own block. One failing callback fails the whole group, so fall back
        // to the proof alone and leave the callbacks to the next block's fulfillment pass.
        const batch = waiting.slice(0, MAX_GROUP_SIZE - 1)
        const group = beacon.newGroup().submitProof(proofCall)
        for (const pending of batch) group.fulfillRequest(fulfillCall(pending))
        try {
          const { txIds, confirmations } = await group.send(SEND)
          proven.add(round)
          failures.delete(key)
          logger.info(
            { ...context, txId: txIds[0], confirmedRound: confirmations[0].confirmedRound },
            'Proof submitted',
          )
          batch.forEach((pending, i) =>
            completed(pending, lastRound, txIds[i + 1], confirmations[i + 1].confirmedRound),
          )
          return
        } catch (err) {
          logger.debug({ ...context, error: describe(err) }, 'Grouped fulfillment failed; submitting the proof alone')
        }
      }
      const result = await beacon.send.submitProof({ ...proofCall, ...SEND })
      proven.add(round)
      failures.delete(key)
      logger.info(
        { ...context, txId: result.txIds[0], confirmedRound: result.confirmation.confirmedRound },
        'Proof submitted',
      )
    } catch (err) {
      failed(key, lastRound, context, 'Proof failed', err)
    }
  }

  async function poll(lastRound: bigint) {
    const [current, account] = await Promise.all([
      beacon.state.global.getAll(),
      algorand.account.getInformation(relayer.addr),
    ])

    const listing = `${current.nextRequestId}:${current.totalPendingRequests}`
    if (listing !== listed) {
      const names = current.totalPendingRequests ? await algorand.app.getBoxNames(beaconAppId) : []
      const ids = new Set(
        names
          .map(({ nameRaw }) => Buffer.from(nameRaw))
          .filter((name) => name.length === 16 && name.subarray(0, 8).equals(REQUESTS_PREFIX))
          .map((name) => name.readBigUInt64BE(8)),
      )
      for (const id of requests.keys()) if (!ids.has(id)) requests.delete(id)
      await Promise.all(
        [...ids]
          .filter((id) => !requests.has(id))
          .map(async (id) => {
            const request = await beacon.state.box.requests.value(id).catch(absent)
            if (request) requests.set(id, request)
          }),
      )
      listed = listing
    }
    const waiting = new Map<bigint, Pending[]>()
    for (const [id, request] of requests)
      waiting.set(request.round, [...(waiting.get(request.round) ?? []), [id, request]])
    for (const round of proven) if (!waiting.has(round)) proven.delete(round)
    for (const round of checkedAt.keys()) if (!waiting.has(round)) checkedAt.delete(round)
    const totalProofs = current.totalProofs!
    await Promise.all(
      roundsToCheck(waiting.keys(), lastRound, proven, checkedAt, totalProofs).map(async (round) => {
        if (isProven(await beacon.state.box.rounds.value(round).catch(absent))) proven.add(round)
        else checkedAt.set(round, totalProofs)
      }),
    )

    const nextHealth = new Map<string, string>()
    // Only log health transitions; keep at most one entry per condition/current request.
    const warn = (issue: string, active: boolean, message: string, context: Record<string, unknown> = {}) => {
      if (!active) return
      nextHealth.set(issue, message)
      if (health.get(issue) !== message) logger.warn({ issue, beaconAppId, ...context }, message)
    }
    const available = account.balance.microAlgo - account.minBalance.microAlgo
    warn('balance', available < LOW_BALANCE.microAlgo, 'Relayer balance is low; fund it to pay fees up front', {
      spendable: available,
    })
    warn(
      'capacity',
      BigInt(requests.size) >= current.maxPendingRequests!,
      'Beacon capacity exhausted; resolve pending requests',
      { pending: requests.size, capacity: current.maxPendingRequests },
    )
    warn('paused', !!current.paused, 'Beacon is paused: no new requests, pending ones are still served')
    const warningWindow = staleTimeout < MAX_SEED_AGE ? staleTimeout : MAX_SEED_AGE
    for (const [requestId, request] of requests) {
      const age = lastRound - request.round
      warn(
        `request:${requestId}`,
        age > 0n && age >= warningWindow / 2n,
        proven.has(request.round)
          ? 'Request callback is failing; its round is proven, so only fulfillment can settle it'
          : age >= MAX_SEED_AGE
            ? 'Request cannot be served; invoke requester-app expiry when eligible'
            : age > staleTimeout
              ? 'Request can be cancelled; its round has not been proven'
              : 'Request is aging; investigate proof submission or requester-app expiry',
        { requestId, requesterAppId: request.requesterAppId, age, expiryAfterRound: request.round + staleTimeout },
      )
    }
    for (const issue of health.keys()) {
      if (!nextHealth.has(issue)) logger.info({ issue, beaconAppId }, 'Beacon health condition cleared')
    }
    health = nextHealth
    for (const key of failures.keys()) {
      const [kind, id] = key.split(':')
      if (!(kind === 'round' ? waiting : requests).has(BigInt(id))) failures.delete(key)
    }
    logger.debug({ pending: requests.size, lastRound }, 'Polled')

    // Independent transactions, so prove and fulfil in parallel; none of these throw.
    const work: Promise<void>[] = []
    const ready: Pending[] = []
    for (const [round, pending] of waiting) {
      if (proven.has(round)) ready.push(...pending.filter(([id]) => !backingOff(`request:${id}`, lastRound)))
      else if (proves && canProve(round, lastRound)) work.push(submitProof(round, pending, lastRound))
    }
    if (fulfills) work.push(...chunk(ready, MAX_GROUP_SIZE).map((batch) => fulfillBatch(batch, lastRound)))
    await Promise.all(work)
  }

  // algokit's HTTP client takes no abort signal, so stop waiting for a block on shutdown instead.
  const stopped = new Promise<never>((_, reject) => signal.addEventListener('abort', reject, { once: true }))
  stopped.catch(() => {})
  // Back off while algod is unreachable (2, 4 … 60 s) instead of logging every attempt.
  let lastRound = 0n
  let pollFailures = 0
  while (!signal.aborted) {
    try {
      // Wake as soon as the next block commits (algod answers after about a minute if none does); retry a
      // failed poll without waiting for another block.
      const status =
        lastRound && !pollFailures
          ? await Promise.race([algod.statusAfterBlock(lastRound).do(), stopped])
          : await algod.status().do()
      lastRound = status.lastRound
      await poll(lastRound)
      if (pollFailures) logger.info({ after: pollFailures }, 'Polling recovered')
      pollFailures = 0
    } catch (err) {
      if (signal.aborted) break
      pollFailures++
      logger.error({ error: describe(err), attempt: pollFailures }, 'Poll failed')
      logger.debug({ err }, 'Poll failure details')
      await sleep(Math.min(1000 * 2 ** pollFailures, 60_000), undefined, { signal }).catch(() => {})
    }
  }
}

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (controller.signal.aborted) {
      logger.warn({ signal }, 'Second signal, exiting immediately')
      process.exit(1)
    }
    logger.info({ signal }, 'Shutting down after the current poll')
    controller.abort()
  })
}

main(controller.signal).then(
  () => {
    logger.info('Stopped')
    // An abandoned wait-for-block request would otherwise keep the process alive for up to a minute.
    process.exit()
  },
  (err) => {
    logger.fatal({ error: err instanceof Error ? err.message : String(err) }, 'Fatal error')
    logger.debug({ err }, 'Fatal error details')
    process.exitCode = 1
  },
)
