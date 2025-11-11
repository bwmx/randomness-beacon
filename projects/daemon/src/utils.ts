import { TransactionSigner } from 'algosdk'
import libvrf from '../../libvrf'
import { RandomnessBeaconClient } from './clients/RandomnessBeaconClient'
import config from './config'

const { algorand } = config

/**
 * Get an environment variable or throw an error if not found
 * @param name name of the environment variable
 * @returns value of the environment variable
 * @throws Error if the environment variable is not found
 */
export function mustGetEnv(name: string) {
  const val = process.env[name]
  if (val === undefined) {
    throw Error(`env ${name} is undefined`)
  }
  return val
}

/**
 * Error thrown when sleep is aborted (so we can determine correct behavior)
 */
export const ErrSleepAborted = new Error('Sleep was aborted')

/**
 * Sleep for a given amount of time
 * @param ms how long to wait for in milliseconds
 * @param signal optional AbortSignal to cancel the sleep
 * @returns Promise that resolves after the given time or rejects if aborted
 * @throws ErrSleepAborted if the sleep is aborted (as intended)
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // check if already aborted
    if (signal?.aborted) {
      reject(ErrSleepAborted)
    }

    const timeout = setTimeout(resolve, ms)

    const onAbort = () => {
      clearTimeout(timeout)
      reject(ErrSleepAborted)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Get the last known round from the algod node
 * @returns last known round
 */
export const getLastRound = async (): Promise<bigint> => {
  const { algod } = algorand.client

  const status = await algod.status().do()

  return status.lastRound
}

/**
 * Create a VRF proof for the given round
 * @param sk VRF secret key
 * @param round round to create the proof for
 * @returns VRF proof for the given round
 */
export const createProofForRound = async (
  sk: Buffer<ArrayBuffer>,
  round: bigint,
): Promise<Uint8Array<ArrayBufferLike>> => {
  // get algod from config
  const { algod } = algorand.client

  // get block from node
  const { block } = await algod.block(round).do()
  // get the seed
  const { seed } = block.header

  const { proof, result } = libvrf.prove(sk, seed)
  if (result !== 0) {
    throw Error('vrf prove failed')
  }

  return proof
}

/**
 * Create a RandomnessBeaconClient instance
 * @param appId randomness beacon app id
 * @param activeAddress address
 * @param transactionSigner TransactionSigner for activeAddress
 * @returns RandomnessBeaconClient instance
 */
export const makeRandomnessBeaconClient = (
  appId: bigint,
  activeAddress: string,
  transactionSigner: TransactionSigner,
): RandomnessBeaconClient => {
  const client = new RandomnessBeaconClient({
    algorand,
    appId: appId,
    defaultSigner: transactionSigner,
    defaultSender: activeAddress,
  })

  return client
}
