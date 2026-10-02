import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { deploy } from './deploy-config'

const publicKey = Buffer.alloc(32, 1)
const limits = { maxPendingRequests: 128n, maxFutureRounds: 100n, staleRequestTimeout: 1000n }
const state = { publicKey: { asByteArray: () => publicKey }, ...limits }
const getAll = vi.fn()
const appClient = { appId: 123n, appAddress: 'app', state: { global: { getAll } } }
const deployApp = vi.fn()
const payment = vi.fn()

beforeEach(() => {
  vi.stubEnv('VRF_KEYPAIR_PUBLIC_KEY', publicKey.toString('base64'))
  for (const name of ['MAX_PENDING_REQUESTS', 'MAX_FUTURE_ROUNDS', 'STALE_REQUEST_TIMEOUT']) vi.stubEnv(name, undefined)
  getAll.mockResolvedValue(state)
  deployApp.mockResolvedValue({ appClient, result: { operationPerformed: 'nothing' } })
  vi.spyOn(AlgorandClient, 'fromEnvironment').mockReturnValue({
    account: { fromEnvironment: async () => ({ addr: 'deployer' }) },
    client: { isLocalNet: async () => true, getTypedAppFactory: () => ({ deploy: deployApp }) },
    send: { payment },
  } as unknown as AlgorandClient)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

test('rejects malformed creation settings before constructing a network client', async () => {
  for (const name of ['MAX_PENDING_REQUESTS', 'MAX_FUTURE_ROUNDS', 'STALE_REQUEST_TIMEOUT']) {
    for (const value of ['', '0', '-1', '1.5', '1e3', '18446744073709551616']) {
      vi.stubEnv(name, value)
      await expect(deploy()).rejects.toThrow(`${name} must be a positive uint64`)
    }
    vi.stubEnv(name, undefined)
  }
  for (const value of ['', 'invalid', publicKey.toString('base64') + '!', Buffer.alloc(33).toString('base64')]) {
    vi.stubEnv('VRF_KEYPAIR_PUBLIC_KEY', value)
    await expect(deploy()).rejects.toThrow('VRF_KEYPAIR_PUBLIC_KEY must be a base64 32-byte VRF public key')
  }
  expect(AlgorandClient.fromEnvironment).not.toHaveBeenCalled()
})

test('accepts uint64 endpoints and an unpadded public key', async () => {
  vi.stubEnv('VRF_KEYPAIR_PUBLIC_KEY', publicKey.toString('base64').replace(/=$/, ''))
  for (const value of [1n, 0xffffffffffffffffn]) {
    for (const name of ['MAX_PENDING_REQUESTS', 'MAX_FUTURE_ROUNDS', 'STALE_REQUEST_TIMEOUT']) {
      vi.stubEnv(name, value.toString())
    }
    const expected = { maxPendingRequests: value, maxFutureRounds: value, staleRequestTimeout: value }
    getAll.mockResolvedValue({ ...state, ...expected })
    await expect(deploy()).resolves.toBe(appClient)
    expect(deployApp).toHaveBeenLastCalledWith(
      expect.objectContaining({
        createParams: {
          method: 'createApplication(byte[32],uint64,uint64,uint64)void',
          args: { publicKey, ...expected },
        },
      }),
    )
  }
})

test('accepts matching repeat deployments without funding them again', async () => {
  await expect(deploy()).resolves.toBe(appClient)
  expect(payment).not.toHaveBeenCalled()
})

test('rejects each mismatched or missing on-chain setting', async () => {
  for (const name of ['publicKey', ...Object.keys(limits)]) {
    for (const value of [undefined, name === 'publicKey' ? { asByteArray: () => Buffer.alloc(32, 2) } : 2n]) {
      getAll.mockResolvedValue({ ...state, [name]: value })
      await expect(deploy()).rejects.toThrow(`Beacon 123 configuration mismatch: ${name}`)
    }
  }
  expect(payment).not.toHaveBeenCalled()
})

test('CLI exits nonzero for unknown contracts, invalid settings, and deployer exceptions', () => {
  for (const [args, env, message] of [
    [['unknown-contract'], {}, 'No deployer found for contract name: unknown-contract'],
    [[], { MAX_PENDING_REQUESTS: '0' }, 'MAX_PENDING_REQUESTS must be a positive uint64'],
    [[], { ALGOD_SERVER: 'invalid-url' }, 'Error deploying randomness_beacon'],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', 'smart_contracts/index.ts', ...args],
      {
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: 20_000,
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
  }
}, 60_000)
