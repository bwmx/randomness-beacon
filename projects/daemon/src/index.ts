import { Algodv2, makeBasicAccountTransactionSigner, mnemonicToSecretKey, TransactionSigner } from 'algosdk'
import { RandomnessBeaconClient } from './contracts/RandomnessBeaconClient'
import * as algokit from '@algorandfoundation/algokit-utils'

import libvrf from '../../libvrf'

const algorand = algokit.AlgorandClient.fromEnvironment()

// https://stackoverflow.com/questions/68329418/in-javascript-how-can-i-throw-an-error-if-an-environmental-variable-is-missing
function getEnv(name: string) {
  const val = process.env[name]
  if (val === undefined) {
    throw Error('env ${name} is undefined')
  }
  return val
}

const beaconAppId = BigInt(getEnv('BEACON_APP_ID'))
const managerAccount = mnemonicToSecretKey(getEnv('MANAGER_MNEMONIC'))
const vrfSecretKey = Buffer.from(getEnv('VRF_KEYPAIR_SECRET_KEY'), 'base64')

const makeRandomnessBeaconClient = (
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

const createProofForRound = async (round: bigint, algod: Algodv2): Promise<Uint8Array<ArrayBufferLike>> => {
  // get block from node
  const { block } = await algod.block(round).do()
  // get the seed
  const { seed } = block.header

  const { proof, result } = libvrf.prove(vrfSecretKey, seed)
  if (result !== 0) {
    throw Error('vrf prove failed')
  }

  return proof
}

;(async () => {
  const { algod } = algorand.client

  // init vrf lib
  await libvrf.init()

  const managerClient = makeRandomnessBeaconClient(
    beaconAppId,
    managerAccount.addr.toString(),
    makeBasicAccountTransactionSigner(managerAccount),
  )

  const totalPendingRequests = await managerClient.state.global.totalPendingRequests()
  if (totalPendingRequests !== undefined) {
    if (totalPendingRequests > 0) {
      console.info(`${totalPendingRequests} pending requests`)
      // get lastRound from chain to get a reference point in time
      const { lastRound } = await algod.status().do()
      // read the boxes to get pending requests
      const boxMap = await managerClient.state.box.requests.getMap()
      for (const [requestId, request] of boxMap) {
        // iterate all and check if can be completed, cancelled or no action
        if (request.round <= lastRound) {
          // request round is available, we should call completeRequest with the vrf proof output
          console.info(
            `RandomnessRequest ${requestId} is ready to be completed (${lastRound - request.round} after target round)`,
          )
          // create the proof
          const proof = await createProofForRound(request.round, algod)
          // send complete request
          await managerClient.send.completeRequest({
            args: [requestId, proof],
            populateAppCallResources: true,
            coverAppCallInnerTransactionFees: true,
            // TODO: consider doing this dynamically, allow users to cover additional fee costs by overpaying to the beacon
            maxFee: algokit.algos(0.012),
          })
        } else if (request.round + 1000n >= lastRound) {
          // we have reached the max amount of time elapsed to complete a request, this round can no longer be accessed
          console.info(
            `RandomnessRequest ${requestId} has timed out (${lastRound - request.round} rounds past accessable round range)`,
          )
          // attempt to cancel the request
          await managerClient.send.cancelRequest({
            args: [requestId],
            populateAppCallResources: true,
            coverAppCallInnerTransactionFees: true,
            maxFee: algokit.algos(0.003), // TODO: consider max fee changing
          })
        } else {
          console.info(
            `RandomnessRequest ${requestId} can be completed at round ${request.round} (in ${request.round - lastRound} rounds)`,
          )
        }
      }
    } else {
      console.info('there are no pending requests')
    }
  } else {
    // does not exist in state, should be impossible as exists and is initialised at creation
    console.warn("totalPendingRequests does not exist in the beacon global state. this shouldn't be possible!")
  }
})().catch((reason) => {
  console.error(reason)
})
