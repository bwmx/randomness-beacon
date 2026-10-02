import { Account, mnemonicToSecretKey } from 'algosdk'
import { keyPairFromSeed } from '@bwmx/algorand-vrf-utils-ts'

export const ROLES = ['watcher', 'keeper', 'both'] as const
export type Role = (typeof ROLES)[number]

export type Config = {
  algodConfig: { server: string; port?: number; token: string }
  beaconAppId: bigint
  /** watcher submits round proofs, keeper fulfills requests of proven rounds, both does both. */
  role: Role
  manager: Account
  /** 64-byte VRF secret key: seed || public key. Absent for a keeper, which never proves. */
  vrfSecretKey?: Uint8Array
  vrfPublicKey?: Uint8Array
}

/**
 * Parses and validates the daemon's environment, reporting every problem at once.
 * Returns explicit algod settings so startup never falls back to LocalNet or constructs KMD/Indexer.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const errors: string[] = []
  const read = (name: string) => env[name]?.trim() ?? ''
  const required = (name: string) => {
    const value = read(name)
    if (!value) errors.push(`${name} is required`)
    return value
  }

  const server = required('ALGOD_SERVER')
  if (server) {
    try {
      const url = new URL(server)
      if (
        !/^https?:\/\//i.test(server) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.port === '0'
      ) {
        throw new Error('Invalid algod URL')
      }
    } catch {
      errors.push(
        'ALGOD_SERVER must be an absolute HTTP(S) URL with a valid port and no credentials, query, or fragment',
      )
    }
  }
  const port = read('ALGOD_PORT')
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    errors.push('ALGOD_PORT must be an integer between 1 and 65535')
  }

  const appId = required('BEACON_APP_ID')
  if (appId && (!/^[1-9]\d*$/.test(appId) || BigInt(appId) > 0xffffffffffffffffn)) {
    errors.push('BEACON_APP_ID must be a positive uint64 (1–18446744073709551615)')
  }

  const role = (read('ROLE') || 'both') as Role
  if (!ROLES.includes(role)) errors.push(`ROLE must be one of ${ROLES.join(', ')}`)

  let manager: Account | undefined
  const mnemonic = required('MANAGER_MNEMONIC')
  if (mnemonic) {
    try {
      manager = mnemonicToSecretKey(mnemonic)
    } catch {
      errors.push('MANAGER_MNEMONIC is not a valid 25-word Algorand mnemonic')
    }
  }

  const encodedKey = role === 'keeper' ? '' : required('VRF_PRIVATE_KEY')
  const vrfSecretKey = Buffer.from(encodedKey, 'base64')
  if (encodedKey) {
    if (
      vrfSecretKey.length !== 64 ||
      ![vrfSecretKey.toString('base64'), vrfSecretKey.toString('base64').replace(/=+$/, '')].includes(encodedKey)
    ) {
      errors.push('VRF_PRIVATE_KEY must be a base64 64-byte VRF secret key (npm run generate-keypair)')
    } else if (!vrfSecretKey.subarray(32).equals(keyPairFromSeed(vrfSecretKey.subarray(0, 32)).publicKey)) {
      errors.push('VRF_PRIVATE_KEY public key does not match its secret seed; restore the original keypair')
    }
  }

  if (errors.length) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`)
  return {
    algodConfig: { server, port: port ? Number(port) : undefined, token: read('ALGOD_TOKEN') },
    beaconAppId: BigInt(appId),
    role,
    manager: manager!,
    ...(encodedKey && { vrfSecretKey, vrfPublicKey: vrfSecretKey.subarray(32) }),
  }
}
