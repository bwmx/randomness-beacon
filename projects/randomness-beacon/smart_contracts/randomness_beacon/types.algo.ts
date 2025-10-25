import { abimethod, arc4, Contract, err, uint64 } from '@algorandfoundation/algorand-typescript'

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
export type FulfillRandomnessFunction = (
  /* request id as reference */
  requestId: arc4.UintN64,
  /* the caller/initiator of the request */
  requesterAddress: arc4.Address,
  /* vrf output */
  output: arc4.StaticBytes<64>,
) => void

export interface RandomnessBeaconCaller {
  /**
   * The function to invoke when closing out of this application
   */
  fulfillRandomness: FulfillRandomnessFunction
}

// events

export class RequestCreated extends arc4.Struct<{
  /* the unique ID of the request */
  requestId: arc4.UintN64
  /* the application ID of the contract making the VRF request */
  requesterAppId: arc4.UintN64
  /* the address of the account making the VRF request, not the app address */
  requesterAddress: arc4.Address
  /* the round at which the VRF of the block seed is requested */
  round: arc4.UintN64
}> {}

export class RequestCancelled extends arc4.Struct<{
  /* the unique ID of the request */
  requestId: arc4.UintN64
  /* the application ID of the contract making the VRF request */
  requesterAppId: arc4.UintN64
  /* the address of the account making the VRF request, not the app address */
  requesterAddress: arc4.Address
}> {}

export class RequestFulfilled extends arc4.Struct<{
  /* the unique ID of the request */
  requestId: arc4.UintN64
  /* the application ID of the contract making the VRF request */
  requesterAppId: arc4.UintN64
  /* the address of the account making the VRF request, not the app address */
  requesterAddress: arc4.Address
  // TODO: include the vrf output
}> {}

export class RandomnessRequest extends arc4.Struct<{
  /* the round the request was created at */
  createdAt: arc4.UintN64
  /* the application ID of the contract making the VRF request */
  requesterAppId: arc4.UintN64
  /* the address of the account making the VRF request, not the app address */
  requesterAddress: arc4.Address
  /* the round at which the VRF of the block seed is requested */
  round: arc4.UintN64
  /* fee paid in advance for the app call, vrf_verify opcode cost (0.008), the inner txn fulfillRequest (0.001) */
  feePaid: arc4.UintN64
  /* box cost paid (can be refunded) */
  boxCost: arc4.UintN64
  /* TODO: implement ability for user to pass data to be hashed with vrf output in future */
  // userData?: arc4.DynamicBytes
}> {}

/**
 * A stub class representing the interface of the caller contract that will receive the VRF output
 * only fulfillRandomness is required
 */
export class RandomnessBeaconCallerStub extends Contract implements RandomnessBeaconCaller {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  @abimethod()
  public fulfillRandomness(
    requestId: arc4.UintN64,
    requesterAddress: arc4.Address,
    output: arc4.StaticBytes<64>,
  ): void {
    err('not implemented')
  }
}
