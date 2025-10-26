import { makeBasicAccountTransactionSigner } from 'algosdk'
import * as algokit from '@algorandfoundation/algokit-utils'
import libvrf from '../../libvrf'
import { createProofForRound, ErrSleepAborted, getLastRound, makeRandomnessBeaconClient, sleep } from './utils'
import config from './config'
import logger from './logger'

const { beaconAppId, managerAccount, vrfSecretKey, pollInterval } = config

const managerClient = makeRandomnessBeaconClient(
  beaconAppId,
  managerAccount.addr.toString(),
  makeBasicAccountTransactionSigner(managerAccount),
)

/**
 * Main worker loop
 * @param signal AbortSignal to stop the loop (potentially used in future)
 * @description
 * This loop will poll for pending randomness requests and process them
 * It will complete requests that are ready and cancel stale requests
 */
const main = async (signal: AbortSignal) => {
  logger.info({ beaconAppId, managerAddress: managerAccount.addr.toString() }, 'Starting RandomnessBeacon daemon')

  // init vrf lib
  await libvrf.init()
  // for debug purposes
  logger.debug('libvrf initialized')

  // get stale request timeout from global state, this will only be used once
  const staleRequestTimeout = await managerClient.state.global.staleRequestTimeout()
  if (staleRequestTimeout === undefined) {
    throw Error('beacon global state is not properly initialized')
  }

  // log for debug purposes
  logger.debug({ staleRequestTimeout: Number(staleRequestTimeout) }, 'staleRequestTimeout retrieved from global state')

  while (!signal.aborted) {
    /**
     * Sleep for the configured poll interval
     * If the sleep is aborted due to the signal, exit the loop
     */
    try {
      await sleep(pollInterval, signal)
    } catch (error: Error | unknown) {
      if (error instanceof Error && error === ErrSleepAborted && signal.aborted) {
        logger.info('Sleep aborted, exiting main worker loop')
        break
      }
    }

    const totalPendingRequests = await managerClient.state.global.totalPendingRequests()
    if (totalPendingRequests === undefined) {
      throw Error('beacon global state is not properly initialized')
    }

    // useful for debugging
    logger.debug({ beaconAppId, totalPendingRequests: Number(totalPendingRequests) }, 'Polled for pending requests')

    if (totalPendingRequests === 0n) {
      continue
    }

    // read the boxes to get pending requests
    const boxMap = await managerClient.state.box.requests.getMap()
    // get lastRound from chain to get a reference point in time
    const lastRound = await getLastRound()
    // log lastRound for debug purposes
    logger.debug({ lastRound }, 'Got last round')
    // loop through all requests
    for (const [requestId, request] of boxMap) {
      const roundsSinceReady = lastRound - request.round

      // not ready yet, skip
      if (roundsSinceReady <= 0n) {
        logger.info(
          { requestId, targetRound: request.round, lastRound, roundsSinceReady },
          'Request not ready yet, skipping',
        )
        continue
      }

      // has timed out, cancel it
      if (roundsSinceReady >= staleRequestTimeout) {
        logger.warn(
          { requestId, targetRound: request.round, lastRound, roundsSinceReady },
          'Request has timed out, attempting to cancel',
        )

        await managerClient.send.cancelRequest({
          args: [requestId],
          populateAppCallResources: true,
          coverAppCallInnerTransactionFees: true,
          maxFee: algokit.algos(0.003), // TODO: consider max fee changing
          suppressLog: true,
        })

        logger.info(
          { requestId, requesterAppId: request.requesterAppId, requesterAddress: request.requesterAddress },
          'Request cancelled successfully',
        )
      } else if (roundsSinceReady > 0n) {
        logger.info(
          { requestId, targetRound: request.round, lastRound, roundsSinceReady },
          'Randomness request is ready to be completed',
        )

        const proof = await createProofForRound(vrfSecretKey, request.round)

        // send complete request
        await managerClient.send.completeRequest({
          args: [requestId, proof],
          populateAppCallResources: true,
          coverAppCallInnerTransactionFees: true,
          // TODO: consider doing this dynamically, allow users to cover additional fee costs by overpaying to the beacon
          maxFee: algokit.algos(0.012),
          suppressLog: true,
          firstValidRound: lastRound,
          validityWindow: 500n, // TODO: investigate why this is required, can't access the target round even when it's within range
        })

        logger.info(
          { requestId, requesterAppId: request.requesterAppId, requesterAddress: request.requesterAddress },
          'Request completed successfully',
        )
      }
    }
  }
}

const abortController = new AbortController()

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully')
  abortController.abort()
})

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully')
  abortController.abort()
})

main(abortController.signal)
  .catch((err: Error) => {
    logger.fatal({ err: err.message }, 'Fatal error')
    process.exit(1)
  })
  .finally(() => {
    logger.info('Daemon is shutting down, goodbye')
  })
