/**
 * Configuration for the Daemon, reads from environment variables and provides algorand instance
 */

import { mnemonicToSecretKey } from 'algosdk'
import { mustGetEnv } from './utils'
import * as algokit from '@algorandfoundation/algokit-utils'

export default {
  algorand: algokit.AlgorandClient.fromEnvironment(),
  pollInterval: Number(mustGetEnv('POLL_INTERVAL')),
  beaconAppId: BigInt(mustGetEnv('BEACON_APP_ID')),
  managerAccount: mnemonicToSecretKey(mustGetEnv('MANAGER_MNEMONIC')),
  vrfSecretKey: Buffer.from(mustGetEnv('VRF_KEYPAIR_SECRET_KEY'), 'base64'),
}
