import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { secretKeyToMnemonic } from 'algosdk'
import { spawnSync } from 'node:child_process'
import { beforeEach, expect, test } from 'vitest'
import { RandomnessBeaconClient } from '../artifacts/randomness_beacon/RandomnessBeaconClient'

const localnet = algorandFixture()
beforeEach(localnet.newScope)

test('deployment CLI creates, reuses, and rejects changed creation settings on LocalNet', async () => {
  const { algorand, testAccount, indexer } = localnet.context
  const publicKey = Buffer.alloc(32, 1)
  const env = {
    ...process.env,
    DOTENV_CONFIG_PATH: '/dev/null',
    ALGOD_SERVER: 'http://localhost',
    ALGOD_PORT: '4001',
    ALGOD_TOKEN: 'a'.repeat(64),
    INDEXER_SERVER: 'http://localhost',
    INDEXER_PORT: '8980',
    INDEXER_TOKEN: 'a'.repeat(64),
    DEPLOYER_MNEMONIC: secretKeyToMnemonic(testAccount.sk),
    DEPLOYER_SENDER: testAccount.addr.toString(),
    VRF_KEYPAIR_PUBLIC_KEY: publicKey.toString('base64'),
    MAX_PENDING_REQUESTS: '7',
    MAX_FUTURE_ROUNDS: '40',
    STALE_REQUEST_TIMEOUT: '50',
  }
  const run = (overrides = {}) => {
    const result = spawnSync('npm', ['run', 'deploy:ci', '--', 'randomness_beacon'], {
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.error).toBeUndefined()
    return result
  }
  const created = run()
  expect(created.status, created.stderr).toBe(0)
  const appId = BigInt(created.stdout.match(/RandomnessBeacon app ID: (\d+)/)![1])
  const beacon = new RandomnessBeaconClient({ algorand, appId })
  const state = await beacon.state.global.getAll()
  expect(state.publicKey?.asByteArray()).toEqual(Uint8Array.from(publicKey))
  expect(state).toMatchObject({ maxPendingRequests: 7n, maxFutureRounds: 40n, staleRequestTimeout: 50n })
  expect((await algorand.account.getInformation(beacon.appAddress)).balance.microAlgo).toBe(1_000_000n)

  // A separate CLI process resolves deployments through Indexer, which can lag algod.
  await expect
    .poll(
      async () => {
        const result = await indexer.lookupAccountCreatedApplications(testAccount.addr).do()
        return result.applications.some((app) => app.id === appId)
      },
      { timeout: 15_000 },
    )
    .toBe(true)

  const repeated = run()
  expect(repeated.status, repeated.stderr).toBe(0)
  expect(repeated.stdout).toContain(`RandomnessBeacon app ID: ${appId}`)
  expect((await algorand.account.getInformation(beacon.appAddress)).balance.microAlgo).toBe(1_000_000n)

  const mismatched = run({
    VRF_KEYPAIR_PUBLIC_KEY: Buffer.alloc(32, 2).toString('base64'),
    MAX_PENDING_REQUESTS: '8',
    MAX_FUTURE_ROUNDS: '41',
    STALE_REQUEST_TIMEOUT: '51',
  })
  expect(mismatched.status).toBe(1)
  expect(mismatched.stderr).toContain(
    `Beacon ${appId} configuration mismatch: publicKey, maxPendingRequests, maxFutureRounds, staleRequestTimeout`,
  )
  expect(await beacon.state.global.getAll()).toEqual(state)
  expect((await algorand.account.getInformation(testAccount.addr)).createdApps?.length).toBe(1)
}, 120_000)
