import { abimethod, arc4, bytes, Contract, err, uint64 } from '@algorandfoundation/algorand-typescript'

export const ERR_PROOF_MUST_BE_VALID = 'proof must be valid'
export const ERR_COSTS_PAYMENT_MUST_BE_VALID = 'costs payment must be valid'
export const ERR_MUST_BE_FUTURE_ROUND = 'must be a future round'
export const ERR_MAX_PENDING_REQUESTS = 'cannot exceed max pending requests'
export const ERR_MUST_BE_CALLED_FROM_APP = 'must be called by an application'
export const ERR_NO_PENDING_REQUESTS = 'no pending requests'
export const ERR_REQUEST_MUST_BE_STALE = 'request must be stale to cancel'
export const ERR_TIMEOUT_CANNOT_BE_ZERO = 'stale request timeout cannot be zero'
export const ERR_MAX_PENDING_REQUESTS_CANNOT_BE_ZERO = 'max pending requests cannot be zero'
export const ERR_MAX_FUTURE_ROUNDS_CANNOT_BE_ZERO = 'max future rounds cannot be zero'
// https://developer.algorand.org/articles/smart-contract-storage-boxes/
export const BOX_CREATE_COST: uint64 = 2500
export const BOX_BYTE_COST: uint64 = 400

export const NOTE_BOX_MBR_REFUND = 'box mbr refund'
export const NOTE_FEES_PAYMENT = 'fees payment for caller'
export const NOTE_CANCEL_PAYMENT = 'cancellation fees for caller'
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
 * The function signature for the fulfillRandomness function
 */
export type FulfillRandomnessFunction = (
  /* request id as reference */
  requestId: uint64,
  /* the caller/initiator of the request */
  requesterAddress: arc4.Address,
  /* vrf output */
  output: VrfOutput,
) => void

/**
 * Interface that a contract must implement to be able to receive VRF outputs from the RandomnessBeacon
 */
export interface IRandomnessBeaconRequester {
  /**
   * The function to invoke when closing out of this application
   */
  fulfillRandomness: FulfillRandomnessFunction
}

/**
 * Group the costs associated with making a randomness request
 */
export type RandomnessRequestCosts = {
  /**
   * the transaction fees paid in advance for the completeRequest() caller
   */
  fees: uint64
  /**
   * The box cost paid for the request (MBR increase)
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
  /* fee paid in advance for the app call, vrf_verify opcode cost (0.008), the inner txn fulfillRequest (0.001) */
  costs: RandomnessRequestCosts
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
   * the VRF output
   */
  vrfOutput: VrfOutput
}

/**
 * A stub class representing the interface of the caller contract that will receive the VRF output
 * only fulfillRandomness is required
 */
export class RandomnessBeaconRequesterStub extends Contract implements IRandomnessBeaconRequester {
  @abimethod()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public fulfillRandomness(requestId: uint64, requesterAddress: arc4.Address, output: VrfOutput): void {
    err('not implemented')
  }
}
