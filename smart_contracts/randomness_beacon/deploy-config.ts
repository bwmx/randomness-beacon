import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { RandomnessBeaconFactory } from '../artifacts/randomness_beacon/RandomnessBeaconClient'

/** Reads a positive uint64 env var, falling back to `fallback` when unset. */
function envUint(name: string, fallback: bigint): bigint {
  const value = process.env[name]?.trim()
  if (value === undefined) return fallback
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > 0xffffffffffffffffn) {
    throw new Error(`${name} must be a positive uint64 (1–18446744073709551615)`)
  }
  return BigInt(value)
}

/**
 * Idempotently deploys the beacon for DEPLOYER (who becomes its manager).
 * Localnet deploys are updatable and update in place; elsewhere the app is immutable and a code change deploys a
 * new app instead (see TMPL_UPDATABLE in contract.algo.ts).
 */
export async function deploy() {
  console.log('=== Deploying RandomnessBeacon ===')

  const encodedKey = process.env.VRF_KEYPAIR_PUBLIC_KEY?.trim() ?? ''
  const publicKey = Buffer.from(encodedKey, 'base64')
  if (
    publicKey.length !== 32 ||
    ![publicKey.toString('base64'), publicKey.toString('base64').replace(/=$/, '')].includes(encodedKey)
  ) {
    throw new Error('VRF_KEYPAIR_PUBLIC_KEY must be a base64 32-byte VRF public key')
  }
  const limits = {
    maxPendingRequests: envUint('MAX_PENDING_REQUESTS', 128n),
    maxFutureRounds: envUint('MAX_FUTURE_ROUNDS', 100n),
    // A longer timeout delays cancellation after the block seed is no longer readable.
    staleRequestTimeout: envUint('STALE_REQUEST_TIMEOUT', 1000n),
  }

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')
  const isLocalNet = await algorand.client.isLocalNet()

  const factory = algorand.client.getTypedAppFactory(RandomnessBeaconFactory, { defaultSender: deployer.addr })
  const { appClient, result } = await factory.deploy({
    updatable: isLocalNet,
    onUpdate: isLocalNet ? 'update' : 'append',
    onSchemaBreak: 'append',
    createParams: {
      method: 'createApplication(byte[32],uint64,uint64,uint64)void',
      args: { publicKey, ...limits },
    },
    updateParams: { method: 'updateApplication', args: [] },
  })

  const state = await appClient.state.global.getAll()
  const mismatches = Object.entries(limits)
    .filter(([name, value]) => state[name as keyof typeof limits] !== value)
    .map(([name]) => name)
  const storedKey = state.publicKey?.asByteArray()
  if (!storedKey || !publicKey.equals(storedKey)) mismatches.unshift('publicKey')
  if (mismatches.length) {
    throw new Error(
      `Beacon ${appClient.appId} configuration mismatch: ${mismatches.join(', ')}. ` +
        'Creation settings do not reconfigure an existing app; use its original settings or deploy a new beacon.',
    )
  }

  // Fund the app account on creation (min balance plus op-up headroom).
  if (['create', 'replace'].includes(result.operationPerformed)) {
    await algorand.send.payment({
      amount: (1).algo(),
      sender: deployer.addr,
      receiver: appClient.appAddress,
    })
  }
  console.log(`RandomnessBeacon app ID: ${appClient.appId} (${isLocalNet ? 'updatable' : 'immutable'})`)
  return appClient
}
