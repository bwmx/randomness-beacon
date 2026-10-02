import { abimethod, arc4, bytes, Contract, loggedErr, uint64 } from '@algorandfoundation/algorand-typescript'

/**
 * ARC-65 error codes (https://arc.algorand.foundation/ARCs/arc-0065): a failing call logs `ERR:<code>` before it fails.
 */
export const ERR_INVALID_PROOF = 'InvalidProof'
export const ERR_INVALID_PAYMENT = 'InvalidPayment'
export const ERR_ROUND_NOT_FUTURE = 'RoundNotFuture'
export const ERR_ROUND_TOO_FAR = 'RoundTooFar'
export const ERR_CAPACITY_EXHAUSTED = 'CapacityExhausted'
export const ERR_CALLER_NOT_APP = 'CallerNotApp'
export const ERR_NOT_REQUESTER_APP = 'NotRequesterApp'
export const ERR_REQUESTS_PENDING = 'RequestsPending'
export const ERR_UNKNOWN_REQUEST = 'UnknownRequest'
export const ERR_NOT_STALE = 'NotStale'
export const ERR_ZERO_MAX_PENDING_REQUESTS = 'ZeroMaxPendingRequests'
export const ERR_ZERO_MAX_FUTURE_ROUNDS = 'ZeroMaxFutureRounds'
export const ERR_ZERO_STALE_TIMEOUT = 'ZeroStaleTimeout'
export const ERR_NOT_UPDATABLE = 'NotUpdatable'
export const ERR_NO_REQUESTS_FOR_ROUND = 'NoRequestsForRound'
export const ERR_SEED_UNAVAILABLE = 'SeedUnavailable'
export const ERR_ROUND_PROVEN = 'RoundProven'
export const ERR_ROUND_NOT_PROVEN = 'RoundNotProven'
export const ERR_NOT_IMPLEMENTED = 'NotImplemented'

// https://developer.algorand.org/articles/smart-contract-storage-boxes/
export const BOX_CREATE_COST: uint64 = 2500
export const BOX_BYTE_COST: uint64 = 400

export const NOTE_BOX_MBR_REFUND = 'box mbr refund'
export const NOTE_FEES_PAYMENT = 'fees payment for caller'
export const NOTE_PROOF_FEES_PAYMENT = 'proof fees payment for caller'
export const NOTE_CLOSE_OUT_REMAINDER = 'close out remainder to manager'

/**
 * Types
 */

/**
 * The VRF keypair public key type (32 bytes)
 */
export type VrfPublicKey = bytes<32>

/**
 * The VRF proof type (will always be 80 bytes)
 */
export type VrfProof = bytes<80>

/**
 * The VRF output type (will always be 64 bytes)
 */
export type VrfOutput = bytes<64>

/**
 * The per-request randomness passed to the requester app:
 * sha256(vrfOutput || itob(beaconAppId) || itob(requestId) || itob(requesterAppId) || requesterAddress)
 */
export type Randomness = bytes<32>

/**
 * The function signature for the fulfillRandomness function
 */
export type FulfillRandomnessFunction = (
  /* request id as reference */
  requestId: uint64,
  /* the caller/initiator of the request */
  requesterAddress: arc4.Address,
  /* randomness derived from the round's vrf output and this request */
  output: Randomness,
) => void

/**
 * Interface that a contract must implement to be able to receive VRF outputs from the RandomnessBeacon
 */
export interface IRandomnessBeaconRequester {
  /**
   * The function to invoke when a randomness request is fulfilled
   */
  fulfillRandomness: FulfillRandomnessFunction
}

/**
 * Group the costs associated with making a randomness request
 */
export type RandomnessRequestCosts = {
  /**
   * the transaction fees paid in advance: the proof fee for the submitProof() caller, the rest for the
   * fulfillRequest() caller
   */
  fees: uint64
  /**
   * The box cost paid for the request: its request box plus a whole round box (MBR increase, refunded)
   */
  boxMbr: uint64
}

/**
 * The randomness request to be stored in a box
 */
export type RandomnessRequest = {
  /* the round the request was created at */
  createdAt: uint64
  /* the application ID of the contract making the VRF request */
  requesterAppId: uint64
  /* the address of the account making the VRF request, not the app address */
  requesterAddress: arc4.Address
  /* the round at which the VRF of the block seed is requested */
  round: uint64
  /* fees paid in advance (proof + fulfillment) and the refundable box deposit */
  costs: RandomnessRequestCosts
  /* this request's share of the round's proof fees, part of costs.fees */
  proofFee: uint64
}

/**
 * Per-round state shared by every request targeting that round, deleted with its last request
 */
export type RoundState = {
  /* number of requests still waiting on this round */
  pending: uint64
  /* proof fees its requests prepaid (fixed once proven) */
  proofFees: uint64
  /* what the prover was paid, 0 until proven; requests are refunded the rest pro rata on fulfillment */
  proofCost: uint64
  /* the verified VRF output of the round's block seed, all zero until proven */
  output: VrfOutput
}

/**
 * Event types emitted by the RandomnessBeacon contract
 */

/**
 * Event emitted when a randomness request is created
 */
export type RequestCreated = {
  /**
   * the unique ID of the request
   */
  requestId: uint64
  /**
   * the application ID of the contract making the VRF request
   */
  requesterAppId: uint64
  /**
   * the address of the account making the VRF request, not the app address
   */
  requesterAddress: arc4.Address
  /**
   * the round at which the VRF of the block seed is requested
   */
  round: uint64
}

/**
 * Event emitted when a randomness request is cancelled
 */
export type RequestCancelled = {
  /**
   * the unique ID of the request
   */
  requestId: uint64
  /**
   * the application ID of the contract making the VRF request
   */
  requesterAppId: uint64
  /**
   * the address of the account making the VRF request, not the app address
   */
  requesterAddress: arc4.Address
}

/**
 * Event emitted when a round's VRF proof is verified and its output stored
 */
export type RoundProven = {
  /**
   * the round whose block seed was proven
   */
  round: uint64
  /**
   * the VRF output of the round's block seed
   */
  vrfOutput: VrfOutput
}

/**
 * Event emitted when a randomness request is fulfilled
 */
export type RequestFulfilled = {
  /**
   * the unique ID of the request
   */
  requestId: uint64
  /**
   * the application ID of the contract making the VRF request
   */
  requesterAppId: uint64
  /**
   * the address of the account making the VRF request, not the app address
   */
  requesterAddress: arc4.Address
  /**
   * the randomness passed to the requester app
   */
  randomness: Randomness
}

/**
 * A stub class representing the interface of the caller contract that will receive the VRF output
 * only fulfillRandomness is required
 */
export class RandomnessBeaconRequesterStub extends Contract implements IRandomnessBeaconRequester {
  @abimethod()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public fulfillRandomness(requestId: uint64, requesterAddress: arc4.Address, output: Randomness): void {
    loggedErr(ERR_NOT_IMPLEMENTED)
  }
}
