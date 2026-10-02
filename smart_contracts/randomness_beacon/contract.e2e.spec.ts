import { algos, microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { init as initVrf, keyPairFromSeed, prove } from '@bwmx/algorand-vrf-utils-ts'
import { Address, encodeUint64, secretKeyToMnemonic } from 'algosdk'
import { ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { ExampleCallerFactory } from '../artifacts/randomness_beacon/contracts/ExampleCallerClient'
import { RandomnessBeaconFactory } from '../artifacts/randomness_beacon/RandomnessBeaconClient'
import { RejectingCallerFactory } from '../artifacts/randomness_beacon/test-fixtures/RejectingCallerClient'

/** getCosts().fees splits into the round prover's share and the request fulfiller's share (1,000 µALGO min fee). */
const PROOF_FEE = 10_000n
const FULFILL_FEE = 4_000n

describe('RandomnessBeacon on LocalNet', () => {
  const localnet = algorandFixture()
  beforeAll(initVrf)
  beforeEach(localnet.newScope)

  async function deploy(timeout = 1000n, capacity = 5n, maxFutureRounds = 100n) {
    const { algorand, testAccount } = localnet.context
    const keys = keyPairFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i))
    const factory = algorand.client.getTypedAppFactory(RandomnessBeaconFactory, {
      defaultSender: testAccount.addr,
      appName: `beacon-test-${timeout}-${capacity}-${maxFutureRounds}`,
    })
    const { appClient: beacon } = await factory.deploy({
      updatable: false,
      onUpdate: 'append',
      onSchemaBreak: 'append',
      createParams: { method: 'createApplication', args: [keys.publicKey, capacity, maxFutureRounds, timeout] },
    })
    const { appClient: caller } = await algorand.client
      .getTypedAppFactory(ExampleCallerFactory, { defaultSender: testAccount.addr })
      .send.create.createApplication({ args: { beaconApp: beacon.appId } })
    for (const receiver of [beacon.appAddress, caller.appAddress]) {
      await algorand.send.payment({ sender: testAccount, receiver, amount: algos(0.1) })
    }
    return { beacon, caller, keys, costs: await beacon.getCosts() }
  }
  type Setup = Awaited<ReturnType<typeof deploy>>

  async function request(setup: Setup, sender: Address, extra = 0n) {
    const payment = localnet.algorand.createTransaction.payment({
      sender,
      receiver: setup.caller.appAddress,
      amount: microAlgos(setup.costs.fees + setup.costs.boxMbr + extra),
    })
    const result = await setup.caller.send.test1({
      sender,
      args: { costsPayment: payment },
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: algos(0.004),
    })
    return result.return!
  }

  async function newCaller(setup: Setup) {
    const { algorand, testAccount } = localnet.context
    const { appClient } = await algorand.client
      .getTypedAppFactory(ExampleCallerFactory, { defaultSender: testAccount.addr })
      .send.create.createApplication({ args: { beaconApp: setup.beacon.appId } })
    await algorand.send.payment({ sender: testAccount, receiver: appClient.appAddress, amount: algos(0.1) })
    return appClient
  }

  /** Creates one request per caller in a single group, so they all target the same (next) round. */
  async function requestTogether(setup: Setup, callers: Setup['caller'][]) {
    const { algorand, testAccount } = localnet.context
    const group = algorand.newGroup()
    for (const caller of callers) {
      group.addAppCallMethodCall(
        await caller.params.test1({
          args: {
            costsPayment: algorand.createTransaction.payment({
              sender: testAccount.addr,
              receiver: caller.appAddress,
              amount: microAlgos(setup.costs.fees + setup.costs.boxMbr),
            }),
          },
          maxFee: algos(0.004),
        }),
      )
    }
    await group.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })
    const ids = await Promise.all(callers.map(async (caller) => (await caller.state.global.requestId())!))
    return { ids, round: (await setup.beacon.state.box.requests.value(ids[0]))!.round }
  }

  async function advancePast(round: bigint) {
    const { algorand, testAccount, algod } = localnet.context
    let lastRound = (await algod.status().do()).lastRound
    while (lastRound <= round) {
      await algorand.send.payment({
        sender: testAccount,
        receiver: testAccount.addr,
        amount: algos(0),
        note: `beacon-test-tick-${lastRound}`,
        suppressLog: true,
      })
      lastRound = (await algod.status().do()).lastRound
    }
    return lastRound
  }

  async function seed(round: bigint) {
    return (await localnet.context.algod.block(round).do()).block.header.seed
  }

  /** Proves `round` in the next block once it is committed. */
  async function submitProof(
    setup: Setup,
    round: bigint,
    params: Partial<Parameters<Setup['beacon']['send']['submitProof']>[0]> = {},
  ) {
    const lastRound = await advancePast(round - 1n)
    return setup.beacon.send.submitProof({
      args: { round, proof: prove(setup.keys.secretKey, await seed(round)).proof },
      firstValidRound: lastRound + 1n,
      validityWindow: 10n,
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: microAlgos(PROOF_FEE),
      ...params,
    })
  }

  function fulfill(
    setup: Setup,
    requestId: bigint,
    params: Partial<Parameters<Setup['beacon']['send']['fulfillRequest']>[0]> = {},
  ) {
    return setup.beacon.send.fulfillRequest({
      args: { requestId },
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: microAlgos(FULFILL_FEE),
      ...params,
    })
  }

  /** Mirrors fulfillRequest: sha256(vrfOutput || beaconAppId || requestId || requesterAppId || requesterAddress). */
  function randomness(
    setup: Setup,
    vrfOutput: Uint8Array,
    requestId: bigint,
    requesterAppId: bigint,
    requester: Address,
  ) {
    return Uint8Array.from(
      createHash('sha256')
        .update(vrfOutput)
        .update(encodeUint64(setup.beacon.appId))
        .update(encodeUint64(requestId))
        .update(encodeUint64(requesterAppId))
        .update(requester.publicKey)
        .digest(),
    )
  }

  type Log = {
    msg: string
    issue?: string
    code?: string
    requestId?: string
    lastRound?: number
    confirmedRound?: number
    level: number
    role: string
  }

  /** A proxy to LocalNet's algod that records request paths and can simulate an RPC outage. */
  async function algodProxy() {
    const paths: string[] = []
    let outage = false
    const server = createServer((incoming, outgoing) => {
      paths.push(incoming.url!)
      if (outage) {
        outgoing.writeHead(503)
        outgoing.end('test RPC outage')
        return
      }
      const upstream = httpRequest(
        { hostname: '127.0.0.1', port: 4001, path: incoming.url, method: incoming.method, headers: incoming.headers },
        (response) => {
          outgoing.writeHead(response.statusCode!, response.headers)
          response.pipe(outgoing)
        },
      )
      upstream.on('error', () => {
        outgoing.writeHead(502)
        outgoing.end()
      })
      incoming.pipe(upstream)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test proxy port')
    return {
      port: String(address.port),
      paths,
      setOutage: (value: boolean) => {
        outage = value
      },
      close: async () => {
        outage = false
        server.closeAllConnections()
        await new Promise<void>((done) => server.close(() => done()))
      },
    }
  }

  /** Spawns compiled daemons; `logs` collects every JSON log line, tagged with the daemon's ROLE. */
  function daemons() {
    const logs: Log[] = []
    const children: ChildProcess[] = []
    let diagnostic = ''
    const start = (env: Record<string, string>) => {
      const child = spawn(process.execPath, [resolve('daemon/dist/index.js')], {
        env: {
          ...process.env,
          ALGOD_SERVER: 'http://127.0.0.1',
          ALGOD_PORT: '4001',
          ALGOD_TOKEN: 'a'.repeat(64),
          LOG_LEVEL: 'info',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      let buffer = ''
      child.stdout!.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop()!
        for (const line of lines) {
          diagnostic += line + '\n'
          try {
            logs.push({ ...JSON.parse(line), role: env.ROLE ?? 'both' })
          } catch {
            /* AlgoKit may also log plain text. */
          }
        }
      })
      child.stderr!.on('data', (chunk) => {
        diagnostic += chunk.toString()
      })
    }
    const waitFor = async (message: string, issue?: string) => {
      await expect
        .poll(() => logs.some((log) => log.msg.includes(message) && (!issue || log.issue === issue)), {
          timeout: 30_000,
          message: `Missing ${message}; daemon output: ${diagnostic}`,
        })
        .toBe(true)
    }
    const stop = async () => {
      for (const child of children.splice(0)) {
        if (child.exitCode !== null || child.signalCode) continue
        const exited = once(child, 'exit')
        const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000)
        child.kill('SIGTERM')
        try {
          expect(await exited).toEqual([0, null])
        } finally {
          clearTimeout(timeout)
        }
      }
    }
    return { logs, start, waitFor, stop }
  }

  test('restricts administration while allowing proof relaying through pause and manager renunciation', async () => {
    const setup = await deploy()
    const { beacon, caller, keys, costs } = setup
    const { algorand, testAccount, generateAccount } = localnet.context
    const next = await generateAccount({ initialFunds: algos(1) })
    const relayer = await generateAccount({ initialFunds: algos(1) })
    await expect(
      beacon.send.updateManager({ sender: next, args: { newManager: next.addr.toString() } }),
    ).rejects.toThrow(/ERR:NotManager/)
    await expect(
      beacon.send.updatePauser({ sender: next, args: { _newPauser: next.addr.toString() } }),
    ).rejects.toThrow(/ERR:NotPauser/)
    await expect(beacon.send.updateManager({ args: { newManager: Address.zeroAddress().toString() } })).rejects.toThrow(
      /ERR:ZeroAddress/,
    )
    await expect(beacon.send.updatePauser({ args: { _newPauser: Address.zeroAddress().toString() } })).rejects.toThrow(
      /ERR:ZeroAddress/,
    )
    await expect(
      beacon.send.update.updateApplication({ args: [], deployTimeParams: { UPDATABLE: 0n } }),
    ).rejects.toThrow(/ERR:NotUpdatable/)
    await beacon.send.updateManager({ args: { newManager: next.addr.toString() } })
    await beacon.send.updatePauser({ args: { _newPauser: next.addr.toString() } })
    await expect(beacon.send.pause({ args: [] })).rejects.toThrow(/ERR:NotPauser/)
    await expect(beacon.send.updateManager({ args: { newManager: testAccount.addr.toString() } })).rejects.toThrow(
      /ERR:NotManager/,
    )
    const [id, round] = await request(setup, testAccount.addr)
    await beacon.send.pause({ sender: next, args: [] })
    expect(await beacon.state.global.paused()).toBe(true)
    const { appClient: other } = await algorand.client
      .getTypedAppFactory(ExampleCallerFactory, { defaultSender: testAccount.addr })
      .send.create.createApplication({ args: { beaconApp: beacon.appId } })
    await algorand.send.payment({ sender: testAccount, receiver: other.appAddress, amount: algos(0.1) })
    await expect(request({ ...setup, caller: other }, testAccount.addr)).rejects.toThrow(/ERR:Paused/)
    await expect(fulfill(setup, id, { sender: relayer })).rejects.toThrow(/ERR:RoundNotProven/)
    await advancePast(round)
    const { proof } = prove(keys.secretKey, await seed(round))
    const invalid = new Uint8Array(proof)
    invalid[40] ^= 1
    const wrongKeyProof = prove(keyPairFromSeed(new Uint8Array(32).fill(99)).secretKey, await seed(round)).proof
    for (const rejectedProof of [invalid, wrongKeyProof]) {
      await expect(
        submitProof(setup, round, { sender: relayer, args: { round, proof: rejectedProof } }),
      ).rejects.toThrow(/ERR:InvalidProof/)
      expect(await beacon.state.global.totalPendingRequests()).toBe(1n)
      expect(await caller.state.global.totalFulfilled()).toBe(0n)
    }
    const balanceBefore = (await algorand.account.getInformation(relayer.addr)).balance.microAlgo
    const proven = await submitProof(setup, round, { sender: relayer })
    const completed = await fulfill(setup, id, { sender: relayer })
    const feeSpent = [...proven.transactions, ...completed.transactions].reduce((sum, txn) => sum + txn.fee, 0n)
    // The relayer earns both shares of the prepaid fees.
    expect((await algorand.account.getInformation(relayer.addr)).balance.microAlgo).toBe(
      balanceBefore - feeSpent + costs.fees,
    )
    await expect(submitProof(setup, round, { sender: relayer })).rejects.toThrow(/ERR:NoRequestsForRound/)
    await expect(fulfill(setup, id, { sender: relayer })).rejects.toThrow(/ERR:UnknownRequest/)
    expect(await caller.state.global.totalFulfilled()).toBe(1n)
    await beacon.send.unpause({ sender: next, args: [] })
    const [secondId, secondRound] = await request({ ...setup, caller: other }, testAccount.addr)
    await beacon.send.deleteManager({ sender: next, args: [] })
    expect(await beacon.manager()).toBe(Address.zeroAddress().toString())
    await expect(
      beacon.send.updateManager({ sender: next, args: { newManager: testAccount.addr.toString() } }),
    ).rejects.toThrow(/ERR:NotManager/)
    await submitProof(setup, secondRound, { sender: relayer })
    await fulfill(setup, secondId, { sender: relayer })
    expect(await other.state.global.totalFulfilled()).toBe(1n)
    expect(await beacon.state.global.totalPendingRequests()).toBe(0n)
  })

  test('enforces exact seed transaction bounds and proof fee cap without consuming a failed proof', async () => {
    const setup = await deploy()
    const { testAccount } = localnet.context
    const [id, round] = await request(setup, testAccount.addr)
    const current = await advancePast(round + 1n)
    const { proof } = prove(setup.keys.secretKey, await seed(round))
    const params = {
      args: { round, proof },
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: microAlgos(PROOF_FEE),
    }
    await expect(
      setup.beacon.send.submitProof({ ...params, firstValidRound: round, lastValidRound: current + 10n }),
    ).rejects.toThrow(/ERR:SeedUnavailable/)
    await expect(
      setup.beacon.send.submitProof({ ...params, firstValidRound: current, lastValidRound: round + 1002n }),
    ).rejects.toThrow(/ERR:SeedUnavailable/)
    await expect(
      setup.beacon.send.submitProof({
        ...params,
        firstValidRound: current,
        lastValidRound: round + 1001n,
        maxFee: microAlgos(1000),
      }),
    ).rejects.toThrow()
    expect(await setup.beacon.state.box.rounds.value(round)).toEqual({
      pending: 1n,
      proofFees: PROOF_FEE,
      proofCost: 0n,
      output: new Uint8Array(64),
    })
    expect(await setup.caller.state.global.totalFulfilled()).toBe(0n)
    await setup.beacon.send.submitProof({ ...params, firstValidRound: round + 1n, lastValidRound: round + 1001n })
    await fulfill(setup, id)
    expect(await setup.beacon.state.global.totalPendingRequests()).toBe(0n)
    expect(await setup.caller.state.global.totalFulfilled()).toBe(1n)
  })

  test('uint64 limit settings preserve creation metadata and reject premature cancellation without overflow', async () => {
    const setup = await deploy(0xffffffffffffffffn, 5n, 0xffffffffffffffffn)
    const { testAccount } = localnet.context
    const [id, round] = await request(setup, testAccount.addr)
    const stored = await setup.beacon.state.box.requests.value(id)
    expect(stored?.createdAt).toBe(round - 1n)
    // 40,900 for the request box plus 43,300 for a whole round box.
    expect(stored?.costs.boxMbr).toBe(84_200n)
    expect(stored?.costs.fees).toBe(PROOF_FEE + FULFILL_FEE)
    expect(stored?.proofFee).toBe(PROOF_FEE)
    await advancePast(round)
    await expect(
      setup.caller.send.expireRequest({
        args: [],
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
        maxFee: algos(0.003),
      }),
    ).rejects.toThrow(/ERR:NotStale/)
    expect(await setup.beacon.state.box.requests.value(id)).toEqual(stored)
    await submitProof(setup, round)
    await fulfill(setup, id)
    expect(await setup.beacon.state.global.totalPendingRequests()).toBe(0n)
  })

  test('daemon handles a full batch, recovers from outages, and settles proven requests only by fulfillment', async () => {
    const setup = await deploy(20n, 5n)
    const { algorand, testAccount, generateAccount } = localnet.context
    const manager = await generateAccount({ initialFunds: algos(0.19) })
    const { appClient: rejecting } = await algorand.client
      .getTypedAppFactory(RejectingCallerFactory, { defaultSender: testAccount.addr })
      .send.create.createApplication({ args: { beaconApp: setup.beacon.appId } })
    await algorand.send.payment({ sender: testAccount, receiver: rejecting.appAddress, amount: algos(0.1) })
    const batchCallers: (typeof setup.caller)[] = []
    for (let i = 0; i < 4; i += 1) {
      const { appClient } = await algorand.client
        .getTypedAppFactory(ExampleCallerFactory, { defaultSender: testAccount.addr })
        .send.create.createApplication({ args: { beaconApp: setup.beacon.appId } })
      await algorand.send.payment({ sender: testAccount, receiver: appClient.appAddress, amount: algos(0.1) })
      await request({ ...setup, caller: appClient }, testAccount.addr)
      batchCallers.push(appClient)
    }
    const [id, round] = await request({ ...setup, caller: rejecting }, testAccount.addr)
    await expect(request(setup, testAccount.addr)).rejects.toThrow(/ERR:CapacityExhausted/)
    await advancePast(round)
    const before = await algorand.account.getInformation(setup.beacon.appAddress)
    const callerBalance = (await algorand.account.getInformation(rejecting.appAddress)).balance.microAlgo
    const proxy = await algodProxy()
    const { logs, start: spawnDaemon, waitFor, stop } = daemons()
    const start = (served = setup) =>
      spawnDaemon({
        ALGOD_PORT: proxy.port,
        BEACON_APP_ID: served.beacon.appId.toString(),
        MANAGER_MNEMONIC: secretKeyToMnemonic(manager.sk),
        VRF_PRIVATE_KEY: Buffer.from(served.keys.secretKey).toString('base64'),
      })
    try {
      start()
      await waitFor('Request failed')
      // The requester's ARC-65 error reaches the daemon's failure log.
      expect(logs.find((log) => log.msg === 'Request failed')?.code).toBe('ERR:TestCallbackRejected')
      await waitFor('Relayer balance is low')
      await waitFor('Beacon capacity exhausted')
      await expect
        .poll(async () =>
          (await Promise.all(batchCallers.map((caller) => caller.state.global.totalFulfilled()))).every(
            (fulfilled) => fulfilled === 1n,
          ),
        )
        .toBe(true)
      expect(await rejecting.state.global.totalFulfilled()).toBe(0n)
      expect(await rejecting.state.global.requestId()).toBe(id)
      expect(await setup.beacon.state.global.totalPendingRequests()).toBe(1n)
      // The rejected callback does not hold back its round's proof (or its proof fee).
      expect((await setup.beacon.state.box.rounds.value(round))?.pending).toBe(1n)
      expect((await algorand.account.getInformation(setup.beacon.appAddress)).balance.microAlgo).toBe(
        before.balance.microAlgo - 4n * (setup.costs.fees + setup.costs.boxMbr) - PROOF_FEE,
      )
      expect((await algorand.account.getInformation(rejecting.appAddress)).balance.microAlgo).toBe(callerBalance)
      // A proof grouped with one fulfillment borrows its budget, needing 7 op-ups instead of 8: it cost 9,000 of the
      // 10,000 prepaid, and the request got the difference back with its deposit.
      for (const caller of batchCallers) {
        expect((await algorand.account.getInformation(caller.appAddress)).balance.microAlgo).toBe(
          100_000n + setup.costs.boxMbr + 1_000n,
        )
      }
      await waitFor('Beacon health condition cleared', 'capacity')
      await stop()
      await rejecting.send.setRejectCallback({ args: { reject: false } })
      await algorand.send.payment({ sender: testAccount, receiver: manager.addr, amount: algos(0.2) })
      start()
      await waitFor('Request completed')
      await expect.poll(() => rejecting.state.global.totalFulfilled(), { timeout: 15_000 }).toBe(1n)
      const { output } = prove(setup.keys.secretKey, await seed(round))
      expect((await rejecting.state.global.output()).asByteArray()).toEqual(
        randomness(setup, output, id, rejecting.appId, testAccount.addr),
      )
      expect(await setup.beacon.state.global.totalPendingRequests()).toBe(0n)

      proxy.setOutage(true)
      const [nextId, nextRound] = await request(setup, testAccount.addr)
      await advancePast(nextRound)
      await waitFor('Poll failed')
      expect(await setup.caller.state.global.totalFulfilled()).toBe(0n)
      proxy.setOutage(false)
      await waitFor('Polling recovered')
      await expect.poll(() => setup.caller.state.global.totalFulfilled(), { timeout: 15_000 }).toBe(1n)
      expect(
        logs.filter((log) => log.msg === 'Request completed' && String(log.requestId) === String(nextId)),
      ).toHaveLength(1)

      // Observe balance changes after startup, even when there are no pending requests.
      const balanceWarnings = logs.filter((log) => log.issue === 'balance' && log.level === 40).length
      const balance = (await algorand.account.getInformation(manager.addr)).balance.microAlgo
      await algorand.send.payment({
        sender: manager,
        receiver: testAccount.addr,
        amount: microAlgos(balance - 151_000n),
      })
      await expect
        .poll(() => logs.filter((log) => log.issue === 'balance' && log.level === 40).length)
        .toBe(balanceWarnings + 1)
      await algorand.send.payment({ sender: testAccount, receiver: manager.addr, amount: algos(0.2) })
      await waitFor('Beacon health condition cleared', 'balance')
      // Administrative role changes do not suspend the independent daemon signer.
      await setup.beacon.send.updateManager({ args: { newManager: manager.addr.toString() } })
      await setup.beacon.send.deleteManager({ sender: manager, args: [] })

      await rejecting.send.claim({
        args: { receiver: testAccount.addr.toString() },
        coverAppCallInnerTransactionFees: true,
        maxFee: algos(0.002),
      })
      const [relayedId, relayedRound] = await request({ ...setup, caller: rejecting }, testAccount.addr)
      await advancePast(relayedRound)
      await expect.poll(() => rejecting.state.global.totalFulfilled(), { timeout: 15_000 }).toBe(2n)
      await expect
        .poll(() => logs.some((log) => log.msg === 'Request completed' && String(log.requestId) === String(relayedId)))
        .toBe(true)
      await rejecting.send.claim({
        args: { receiver: testAccount.addr.toString() },
        coverAppCallInnerTransactionFees: true,
        maxFee: algos(0.002),
      })
      // A proven round's outcome is public, so a stale request with a failing callback cannot be expired.
      await rejecting.send.setRejectCallback({ args: { reject: true } })
      const [staleId, staleRound] = await request({ ...setup, caller: rejecting }, testAccount.addr)
      await advancePast(staleRound + 10n)
      await waitFor('Request callback is failing', `request:${staleId}`)
      await advancePast(staleRound + 21n)
      const pollErrors = logs.filter((log) => log.msg === 'Poll failed').length
      await setup.beacon.send.pause({ args: [] })
      await waitFor('Beacon is paused')
      await setup.beacon.send.unpause({ args: [] })
      await waitFor('Beacon health condition cleared', 'paused')
      expect(
        logs.filter((log) => log.msg.includes('Request callback is failing') && log.issue === `request:${staleId}`),
      ).toHaveLength(1)
      expect(logs.filter((log) => log.msg === 'Poll failed')).toHaveLength(pollErrors)
      await expect(
        rejecting.send.expireRequest({
          args: [],
          populateAppCallResources: true,
          coverAppCallInnerTransactionFees: true,
          maxFee: algos(0.003),
        }),
      ).rejects.toThrow(/ERR:RoundProven/)
      // Once the callback works, the daemon's retry (backed off at most 32 rounds by now) settles it.
      await rejecting.send.setRejectCallback({ args: { reject: false } })
      await advancePast(staleRound + 64n)
      await waitFor('Beacon health condition cleared', `request:${staleId}`)
      expect(await rejecting.state.global.totalFulfilled()).toBe(3n)
      expect(await setup.beacon.state.global.totalPendingRequests()).toBe(0n)
      await stop()

      // Previously, timeout=1 left the daemon with no completion window at all.
      const shortTimeout = await deploy(1n)
      const [shortId, shortRound] = await request(shortTimeout, testAccount.addr)
      await advancePast(shortRound + 1n)
      logs.length = 0
      start(shortTimeout)
      await expect.poll(() => shortTimeout.caller.state.global.totalFulfilled(), { timeout: 15_000 }).toBe(1n)
      await expect
        .poll(() => logs.some((log) => log.msg === 'Request completed' && String(log.requestId) === String(shortId)))
        .toBe(true)
      expect(await shortTimeout.beacon.state.global.totalPendingRequests()).toBe(0n)
    } finally {
      try {
        await stop()
      } finally {
        await proxy.close()
      }
    }
  }, 120_000)

  test('a keeper reads no boxes until a proof lands, then fulfills the proven requests in one group', async () => {
    const setup = await deploy()
    const { algod, generateAccount } = localnet.context
    const keeper = await generateAccount({ initialFunds: algos(1) })
    const callers = [setup.caller, await newCaller(setup), await newCaller(setup)]
    const { ids, round } = await requestTogether(setup, callers)
    const proxy = await algodProxy()
    const { logs, start, stop } = daemons()
    const boxReads = () => proxy.paths.filter((path) => path.includes('/box?')).length
    const polledAt = (target: bigint) =>
      expect
        .poll(() => logs.some((log) => log.msg === 'Polled' && BigInt(log.lastRound!) >= target), { timeout: 15_000 })
        .toBe(true)
    try {
      start({
        ALGOD_PORT: proxy.port,
        BEACON_APP_ID: setup.beacon.appId.toString(),
        ROLE: 'keeper',
        MANAGER_MNEMONIC: secretKeyToMnemonic(keeper.sk),
        LOG_LEVEL: 'debug',
      })
      // Once synced, blocks read no boxes: request boxes never change and no proof has landed.
      await polledAt(await advancePast(round))
      const synced = boxReads()
      await polledAt(await advancePast((await algod.status().do()).lastRound + 5n))
      expect(boxReads()).toBe(synced)

      // A proof moves totalProofs, so the keeper reads the round once and fulfills its requests together.
      await submitProof(setup, round)
      await expect
        .poll(
          async () =>
            (await Promise.all(callers.map((caller) => caller.state.global.totalFulfilled()))).every((n) => n === 1n),
          { timeout: 15_000 },
        )
        .toBe(true)
      const completed = () => logs.filter((log) => log.msg === 'Request completed')
      await expect.poll(() => completed().length).toBe(ids.length)
      expect(
        completed()
          .map((log) => String(log.requestId))
          .sort(),
      ).toEqual(ids.map(String).sort())
      // Dev-mode LocalNet makes one block per submission, so one confirmed round means one group.
      expect(new Set(completed().map((log) => log.confirmedRound)).size).toBe(1)
      expect(boxReads()).toBe(synced + 1)
    } finally {
      try {
        await stop()
      } finally {
        await proxy.close()
      }
    }
  })

  test('a watcher holding the VRF key and a keeper without it split delivery', async () => {
    const setup = await deploy()
    const { testAccount, generateAccount } = localnet.context
    const [watcher, keeper] = await Promise.all([1, 2].map(() => generateAccount({ initialFunds: algos(1) })))
    const { logs, start, stop } = daemons()
    try {
      const beacon = { BEACON_APP_ID: setup.beacon.appId.toString() }
      start({
        ...beacon,
        ROLE: 'watcher',
        MANAGER_MNEMONIC: secretKeyToMnemonic(watcher.sk),
        VRF_PRIVATE_KEY: Buffer.from(setup.keys.secretKey).toString('base64'),
      })
      start({ ...beacon, ROLE: 'keeper', MANAGER_MNEMONIC: secretKeyToMnemonic(keeper.sk) })
      const [id, round] = await request(setup, testAccount.addr)
      await advancePast(round)
      await expect.poll(() => setup.caller.state.global.totalFulfilled(), { timeout: 15_000 }).toBe(1n)
      await expect
        .poll(() =>
          logs.filter((log) => log.msg === 'Request completed').map((log) => [log.role, String(log.requestId)]),
        )
        .toEqual([['keeper', String(id)]])
      expect(logs.filter((log) => log.msg === 'Proof submitted').map((log) => log.role)).toEqual(['watcher'])
    } finally {
      await stop()
    }
  })

  test('one proof serves every request on its round with distinct randomness, and proven requests cannot expire', async () => {
    const setup = await deploy(1n)
    const { algorand, testAccount, generateAccount } = localnet.context
    const prover = await generateAccount({ initialFunds: algos(1) })
    const callers = [setup.caller, await newCaller(setup)]
    const { ids, round } = await requestTogether(setup, callers)
    expect((await setup.beacon.state.box.requests.value(ids[1]))!.round).toBe(round)
    expect(await setup.beacon.state.box.rounds.value(round)).toEqual({
      pending: 2n,
      proofFees: 2n * PROOF_FEE,
      proofCost: 0n,
      output: new Uint8Array(64),
    })
    await expect(fulfill(setup, ids[0])).rejects.toThrow(/ERR:RoundNotProven/)

    // The target round is provable the moment it is committed, landing the proof in the very next block.
    const lastRound = await advancePast(round - 1n)
    expect(lastRound).toBe(round)
    // A round nobody requested cannot be proven, even with a valid proof.
    await expect(
      setup.beacon.send.submitProof({
        args: { round: round - 1n, proof: prove(setup.keys.secretKey, await seed(round - 1n)).proof },
        firstValidRound: lastRound + 1n,
        validityWindow: 10n,
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
        maxFee: microAlgos(PROOF_FEE),
      }),
    ).rejects.toThrow(/ERR:NoRequestsForRound/)
    const before = (await algorand.account.getInformation(prover.addr)).balance.microAlgo
    const proven = await submitProof(setup, round, { sender: prover })
    expect(proven.confirmation.confirmedRound).toBe(round + 1n)
    expect(await setup.beacon.state.global.totalProofs()).toBe(1n)
    // One verification for both requests: the prover is reimbursed what it cost, not both prepaid proof fees.
    expect((await algorand.account.getInformation(prover.addr)).balance.microAlgo).toBe(before)
    expect((await setup.beacon.state.box.rounds.value(round))?.proofCost).toBe(PROOF_FEE)
    await expect(submitProof(setup, round)).rejects.toThrow(/ERR:RoundProven/)

    // Every outcome on the round is now public: a stale request must not be discarded by expiry.
    await advancePast(round + 2n)
    await expect(
      setup.caller.send.expireRequest({
        args: [],
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
        maxFee: algos(0.003),
      }),
    ).rejects.toThrow(/ERR:RoundProven/)
    for (const id of ids) await fulfill(setup, id)
    const { output } = prove(setup.keys.secretKey, await seed(round))
    const outputs = await Promise.all(callers.map(async (caller) => (await caller.state.global.output()).asByteArray()))
    callers.forEach((caller, i) =>
      expect(outputs[i]).toEqual(randomness(setup, output, ids[i], caller.appId, testAccount.addr)),
    )
    expect(outputs[0]).not.toEqual(outputs[1])
    expect((await setup.beacon.state.box.rounds.getMap()).size).toBe(0)
    // Every deposit and fee has been paid out: only the beacon's initial funding remains, and the requests split
    // the proof fee they prepaid but did not need.
    expect((await algorand.account.getInformation(setup.beacon.appAddress)).balance.microAlgo).toBe(100_000n)
    for (const caller of callers) {
      expect((await algorand.account.getInformation(caller.appAddress)).balance.microAlgo).toBe(
        100_000n + setup.costs.boxMbr + PROOF_FEE / 2n,
      )
    }
  })

  test('creates the configured immutable beacon and an accounted pending request', async () => {
    const setup = await deploy()
    const [id, round] = await request(setup, localnet.context.testAccount.addr)
    expect(await setup.beacon.state.global.totalPendingRequests()).toBe(1n)
    expect((await setup.beacon.state.box.requests.getMap()).get(id)?.round).toBe(round)
    expect(await setup.beacon.state.box.rounds.value(round)).toEqual({
      pending: 1n,
      proofFees: PROOF_FEE,
      proofCost: 0n,
      output: new Uint8Array(64),
    })
    expect(await setup.caller.state.global.requestId()).toBe(id)
    expect(await setup.caller.state.global.refund()).toBe(setup.costs.boxMbr)
    await expect(request(setup, localnet.context.testAccount.addr)).rejects.toThrow(/ERR:PreviousRequestUnclaimed/)
  })

  test('rejects a forged callback and a deposit paid to somebody else', async () => {
    const setup = await deploy()
    const { testAccount, algorand } = localnet.context
    await expect(
      setup.caller.send.fulfillRandomness({
        args: { requestId: 1n, requesterAddress: testAccount.addr.toString(), output: new Uint8Array(32) },
      }),
    ).rejects.toThrow(/ERR:UnauthorizedCallback/)
    const misdirected = algorand.createTransaction.payment({
      sender: testAccount,
      receiver: testAccount.addr,
      amount: microAlgos(setup.costs.fees + setup.costs.boxMbr),
    })
    await expect(
      setup.caller.send.test1({
        args: { costsPayment: misdirected },
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
        maxFee: algos(0.004),
      }),
    ).rejects.toThrow()
    expect(await setup.beacon.state.global.totalPendingRequests()).toBe(0n)
    expect((await algorand.account.getInformation(setup.caller.appAddress)).balance.microAlgo).toBe(100_000n)
  })

  test('only requester-app expiry can cancel, even after the user closes their account', async () => {
    const setup = await deploy(2n)
    const { testAccount, algorand, generateAccount } = localnet.context
    const player = await generateAccount({ initialFunds: algos(1) })
    // Keeps the refund (98,200 + extra) below the 0.1 ALGO minimum balance, so claiming to an empty account fails.
    const extra = 1000n
    const [id, round] = await request(setup, player.addr, extra)
    await algorand.send.payment({
      sender: player,
      receiver: testAccount.addr,
      amount: algos(0),
      closeRemainderTo: testAccount.addr,
    })
    await advancePast(round + 2n)
    await expect(
      setup.beacon.send.cancelRequest({
        args: { requestId: id },
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
        maxFee: algos(0.003),
      }),
    ).rejects.toThrow(/ERR:NotRequesterApp/)
    expect(await setup.beacon.state.global.totalPendingRequests()).toBe(1n)
    await setup.caller.send.expireRequest({
      args: [],
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: algos(0.003),
    })
    const refund = setup.costs.boxMbr + setup.costs.fees + extra
    expect(await setup.caller.state.global.refund()).toBe(refund)
    expect(await setup.caller.state.global.requestId()).toBe(0n)
    expect(await setup.beacon.state.global.totalPendingRequests()).toBe(0n)
    expect((await setup.beacon.state.box.requests.getMap()).size).toBe(0)
    expect((await setup.beacon.state.box.rounds.getMap()).size).toBe(0)
    expect((await algorand.account.getInformation(setup.beacon.appAddress)).balance.microAlgo).toBe(100_000n)
    expect((await algorand.account.getInformation(setup.caller.appAddress)).balance.microAlgo).toBe(100_000n + refund)
    await expect(setup.caller.send.claim({ args: { receiver: testAccount.addr.toString() } })).rejects.toThrow(
      /ERR:NotRequester/,
    )
    // Re-fund only for the user's claim fee; settlement above required no user account funding.
    await algorand.send.payment({ sender: testAccount, receiver: player.addr, amount: algos(0.2) })
    await expect(
      setup.caller.send.claim({
        sender: player.addr,
        args: { receiver: algorand.account.random().addr.toString() },
        coverAppCallInnerTransactionFees: true,
        maxFee: algos(0.002),
      }),
    ).rejects.toThrow()
    expect(await setup.caller.state.global.refund()).toBe(refund)
    await setup.caller.send.claim({
      sender: player.addr,
      args: { receiver: testAccount.addr.toString() },
      coverAppCallInnerTransactionFees: true,
      maxFee: algos(0.002),
    })
    expect(await setup.caller.state.global.refund()).toBe(0n)
    expect((await algorand.account.getInformation(setup.caller.appAddress)).balance.microAlgo).toBe(100_000n)
    await expect(
      setup.caller.send.claim({
        sender: player.addr,
        args: { receiver: testAccount.addr.toString() },
      }),
    ).rejects.toThrow(/ERR:NoSettledRefund/)
  })

  test('real VRF fulfillment refunds the app despite a closed user, rejects invalid proofs, and permits reuse after claim', async () => {
    const setup = await deploy()
    const { testAccount, algorand, generateAccount } = localnet.context
    const player = await generateAccount({ initialFunds: algos(1) })
    const [id, round] = await request(setup, player.addr)
    await algorand.send.payment({
      sender: player,
      receiver: testAccount.addr,
      amount: algos(0),
      closeRemainderTo: testAccount.addr,
    })
    await advancePast(round)
    const { proof, output } = prove(setup.keys.secretKey, await seed(round))
    const invalid = new Uint8Array(proof)
    invalid[40] ^= 1
    await expect(submitProof(setup, round, { args: { round, proof: invalid } })).rejects.toThrow(/ERR:InvalidProof/)
    expect(await setup.beacon.state.global.totalPendingRequests()).toBe(1n)
    await submitProof(setup, round)
    await fulfill(setup, id)
    expect((await setup.caller.state.global.output()).asByteArray()).toEqual(
      randomness(setup, output, id, setup.caller.appId, player.addr),
    )
    expect(await setup.caller.state.global.totalFulfilled()).toBe(1n)
    expect(await setup.caller.state.global.requestId()).toBe(0n)
    expect(await setup.beacon.state.global.totalPendingRequests()).toBe(0n)
    expect((await setup.beacon.state.box.requests.getMap()).size).toBe(0)
    expect((await algorand.account.getInformation(setup.caller.appAddress)).balance.microAlgo).toBe(
      100_000n + setup.costs.boxMbr,
    )
    await algorand.send.payment({ sender: testAccount, receiver: player.addr, amount: algos(0.2) })
    await setup.caller.send.claim({
      sender: player.addr,
      args: { receiver: testAccount.addr.toString() },
      coverAppCallInnerTransactionFees: true,
      maxFee: algos(0.002),
    })
    const [nextId] = await request(setup, testAccount.addr)
    expect(nextId).toBe(id + 1n)
  })
})
