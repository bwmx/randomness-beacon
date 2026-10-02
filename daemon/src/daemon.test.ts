import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateAccount, secretKeyToMnemonic } from 'algosdk'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { init, keyPairFromSeed, prove, verify } from '@bwmx/algorand-vrf-utils-ts'
import { spawnSync } from 'node:child_process'
import { loadConfig } from './config'
import { errorCode } from './logger'
import { canProve, chunk, retryDelay, roundsToCheck } from './plan'

const account = generateAccount()
const keys = keyPairFromSeed(Buffer.alloc(32, 7))
const validEnv = {
  ALGOD_SERVER: 'http://localhost',
  BEACON_APP_ID: '1234',
  MANAGER_MNEMONIC: secretKeyToMnemonic(account.sk),
  VRF_PRIVATE_KEY: Buffer.from(keys.secretKey).toString('base64'),
}

test('canProve: from the moment the round commits until its seed leaves the transaction window', () => {
  const round = 1_000n
  assert.equal(canProve(round, 999n), false) // target round not committed yet
  // FirstValid = lastRound + 1, so the just-committed round is provable in the next block
  for (let age = 0n; age <= 990n; age++) assert.equal(canProve(round, round + age), true)
  assert.equal(canProve(round, 1_991n), false) // LastValid - 1002 would no longer be below the round
  assert.equal(canProve(round, 2_000n), false)
})

test('roundsToCheck reads only past rounds not known proven, and unproven ones again only after a new proof', () => {
  const rounds = [8n, 9n, 10n, 11n, 12n]
  const proven = new Set([8n])
  const checkedAt = new Map([
    [9n, 3n],
    [10n, 2n],
  ])
  // 8 is proven; 9 was unproven at the current count; 10 was checked before a later proof; 11 never checked;
  // 12 is the last committed round, which no proof can have reached yet.
  assert.deepEqual(roundsToCheck(rounds, 12n, proven, checkedAt, 3n), [10n, 11n])
  // With no new proof since, nothing needs reading.
  checkedAt.set(10n, 3n).set(11n, 3n)
  assert.deepEqual(roundsToCheck(rounds, 12n, proven, checkedAt, 3n), [])
  assert.deepEqual(roundsToCheck(rounds, 13n, proven, checkedAt, 3n), [12n])
  assert.deepEqual(roundsToCheck(rounds, 13n, proven, checkedAt, 4n), [9n, 10n, 11n, 12n])
})

test('chunk splits into groups of at most the given size', () => {
  assert.deepEqual(chunk([], 16), [])
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]])
  assert.deepEqual(
    chunk(
      Array.from({ length: 33 }, (_, i) => i),
      16,
    ).map((group) => group.length),
    [16, 16, 1],
  )
})

test('errorCode extracts the innermost ARC-65 error quoted in algod details', () => {
  const inner = new Error(
    'inner tx 1 failed: logic eval error: err opcode executed. Details: app=7, pc=743, opcodes=pushbytes 0x45 // "ERR:Paused"; log; err',
  )
  assert.equal(errorCode(inner), 'ERR:Paused')
  assert.equal(errorCode(new Error('x opcodes=bytec 13 // "ERR:042:Bad thing"; log; err')), 'ERR:042:Bad thing')
  assert.equal(errorCode(new Error('logic eval error: assert failed pc=12')), undefined)
})

test('retryDelay doubles up to 64 rounds', () => {
  assert.deepEqual([1, 2, 3, 6, 7, 20].map(retryDelay), [2n, 4n, 8n, 64n, 64n, 64n])
})

test('loadConfig validates everything and reports all problems together', () => {
  const config = loadConfig(validEnv)
  assert.equal(config.beaconAppId, 1234n)
  assert.equal(config.manager.addr.toString(), account.addr.toString())
  assert.deepEqual(Buffer.from(config.vrfPublicKey!), Buffer.from(keys.publicKey))
  assert.equal(config.role, 'both')

  assert.throws(
    () => loadConfig({ BEACON_APP_ID: '0', ROLE: 'relayer', MANAGER_MNEMONIC: 'nope', VRF_PRIVATE_KEY: 'AAAA' }),
    (err: Error) =>
      [
        'ALGOD_SERVER is required',
        'BEACON_APP_ID must be a positive uint64',
        'ROLE must be one of watcher, keeper, both',
        'MANAGER_MNEMONIC is not a valid',
        'VRF_PRIVATE_KEY must be a base64 64-byte',
      ].every((text) => err.message.includes(text)),
  )
})

test('loadConfig requires the VRF key only for roles that prove', () => {
  const { VRF_PRIVATE_KEY: _, ...withoutKey } = validEnv
  for (const role of ['watcher', 'both', '']) {
    assert.equal(loadConfig({ ...validEnv, ROLE: role }).role, role || 'both')
    assert.throws(() => loadConfig({ ...withoutKey, ROLE: role }), /VRF_PRIVATE_KEY is required/)
  }
  const keeper = loadConfig({ ...withoutKey, ROLE: 'keeper' })
  assert.equal(keeper.role, 'keeper')
  assert.equal(keeper.vrfSecretKey, undefined)
  // A keeper never holds the key, even if one is configured.
  assert.equal(loadConfig({ ...validEnv, ROLE: 'keeper' }).vrfSecretKey, undefined)
})

test('loadConfig enforces app ID bounds without losing bigint precision', () => {
  for (const value of ['1', '18446744073709551615']) {
    assert.equal(loadConfig({ ...validEnv, BEACON_APP_ID: value }).beaconAppId, BigInt(value))
  }
  for (const value of ['0', '-1', '1.5', '1e3', '18446744073709551616', '9'.repeat(400)]) {
    assert.throws(() => loadConfig({ ...validEnv, BEACON_APP_ID: value }), /BEACON_APP_ID must be a positive uint64/)
  }
})

test('loadConfig rejects malformed keys and either corrupted half without exposing the secret', async () => {
  const key = validEnv.VRF_PRIVATE_KEY
  for (const value of ['AAAA', key + '!', key + '=', Buffer.alloc(65).toString('base64')]) {
    assert.throws(() => loadConfig({ ...validEnv, VRF_PRIVATE_KEY: value }), /VRF_PRIVATE_KEY must be a base64 64-byte/)
  }
  for (const position of [0, 32]) {
    const damaged = Buffer.from(keys.secretKey)
    damaged[position] ^= 1
    const encoded = damaged.toString('base64')
    assert.throws(
      () => loadConfig({ ...validEnv, VRF_PRIVATE_KEY: encoded }),
      (error: Error) => {
        assert.match(error.message, /public key does not match its secret seed/)
        assert.ok(!error.message.includes(encoded))
        return true
      },
    )
  }
  const config = loadConfig({ ...validEnv, VRF_PRIVATE_KEY: key.replace(/=+$/, '') })
  await init()
  const seed = Buffer.alloc(32, 1)
  const { proof, output } = prove(config.vrfSecretKey!, seed)
  assert.deepEqual(verify(config.vrfPublicKey!, seed, proof), output)
})

test('loadConfig validates HTTP(S) URLs and optional ports', () => {
  for (const server of ['https://rpc.example/algod', 'http://localhost:4001', 'http://[::1]:4001']) {
    assert.equal(loadConfig({ ...validEnv, ALGOD_SERVER: server }).algodConfig.server, server)
  }
  for (const server of [
    'localhost:4001',
    'https:rpc.example',
    'ftp://rpc.example',
    'file:///tmp/algod',
    'http://localhost:0',
    'http://localhost:65536',
    'https://user:secret@rpc.example',
    'https://rpc.example?token=secret',
    'https://rpc.example#fragment',
  ]) {
    assert.throws(
      () => loadConfig({ ...validEnv, ALGOD_SERVER: server }),
      /ALGOD_SERVER must be an absolute HTTP\(S\) URL/,
    )
  }
  for (const value of ['1', '65535']) {
    assert.equal(loadConfig({ ...validEnv, ALGOD_PORT: value }).algodConfig.port, Number(value))
  }
  for (const value of ['0', '-1', '1.5', '1e3', '65536', 'Infinity']) {
    assert.throws(() => loadConfig({ ...validEnv, ALGOD_PORT: value }), /ALGOD_PORT must be an integer/)
  }
})

test('algod-only configuration preserves URL ports and paths, handles tokenless RPC, and creates no KMD/Indexer', async (t) => {
  const requests: { url: string; token: string | null }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    requests.push({ url: String(url), token: new Headers(options.headers).get('X-Algo-API-Token') })
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  for (const [env, expectedPort, expectedToken] of [
    [{}, '4443', ''],
    [{ ALGOD_PORT: '', ALGOD_TOKEN: '' }, '4443', ''],
    [{ ALGOD_PORT: '4001', ALGOD_TOKEN: 'test-token' }, '4001', 'test-token'],
  ] as const) {
    const { algodConfig } = loadConfig({ ...validEnv, ALGOD_SERVER: 'https://custom-rpc.example:4443/algod', ...env })
    const client = AlgorandClient.fromConfig({ algodConfig })
    assert.equal(client.client.indexerIfPresent, undefined)
    assert.throws(() => client.client.kmd, /no Kmd configured/)
    await client.client.algod.healthCheck().do()
    assert.deepEqual(requests[requests.length - 1], {
      url: `https://custom-rpc.example:${expectedPort}/algod/health`,
      token: expectedToken,
    })
  }
})

test('daemon startup exits nonzero on a corrupt key before connecting to algod', () => {
  const damaged = Buffer.from(keys.secretKey)
  damaged[0] ^= 1
  const result = spawnSync(process.execPath, ['-r', 'ts-node/register', 'src/index.ts'], {
    env: { ...process.env, ...validEnv, VRF_PRIVATE_KEY: damaged.toString('base64'), LOG_LEVEL: 'info' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /public key does not match its secret seed/)
  assert.ok(!result.stdout.includes(damaged.toString('base64')))
})
