import {
  abimethod,
  arc4,
  assert,
  assertMatch,
  BoxMap,
  contract,
  Contract,
  emit,
  ensureBudget,
  Global,
  GlobalState,
  gtxn,
  itxn,
  op,
  OpUpFeeSource,
  Txn,
  uint64,
  VrfVerify,
} from '@algorandfoundation/algorand-typescript'
import { classes } from 'polytype'
import { Managable } from './contracts/managable.algo'
import { Pausable } from './contracts/pausable.algo'
import {
  BOX_BYTE_COST,
  BOX_CREATE_COST,
  ERR_COSTS_PAYMENT_MUST_BE_VALID,
  ERR_MAX_FUTURE_ROUNDS_CANNOT_BE_ZERO,
  ERR_MAX_PENDING_REQUESTS,
  ERR_MAX_PENDING_REQUESTS_CANNOT_BE_ZERO,
  ERR_MUST_BE_CALLED_FROM_APP,
  ERR_MUST_BE_FUTURE_ROUND,
  ERR_NO_PENDING_REQUESTS,
  ERR_PROOF_MUST_BE_VALID,
  ERR_REQUEST_MUST_BE_STALE,
  ERR_TIMEOUT_CANNOT_BE_ZERO,
  NOTE_BOX_MBR_REFUND,
  NOTE_CANCEL_PAYMENT,
  NOTE_CLOSE_OUT_REMAINDER,
  NOTE_FEES_PAYMENT,
  RandomnessBeaconCallerStub,
  RandomnessRequest,
  RequestCancelled,
  RequestCreated,
  RequestFulfilled,
} from './types.algo'

@contract({ name: 'RandomnessBeacon', avmVersion: 11 })
export class RandomnessBeacon extends classes(Managable, Pausable, Contract) implements arc4.ConventionalRouting {
  /* the public key used to verify VRF proofs */
  publicKey = GlobalState<arc4.StaticBytes<32>>({ key: 'publicKey' })

  /* the next requestId index, useful for tracking. set to 1 initially */
  nextRequestId = GlobalState<arc4.UintN64>({ key: 'nextRequestId', initialValue: new arc4.UintN64(1) })

  /* box map of randomness requests */
  requests = BoxMap<arc4.UintN64, RandomnessRequest>({ keyPrefix: 'requests' })

  /**
   * Max rounds in the future ([current round] + maxFutureRounds) allowed for requests
   */
  maxFutureRounds = GlobalState<arc4.UintN64>({
    key: 'maxFutureRounds',
  })

  /**
   * Max number of pending requests allowed
   */
  maxPendingRequests = GlobalState<arc4.UintN64>({
    key: 'maxPendingRequests',
  })

  /**
   * Stale request timeout in rounds (after which a request can be cancelled after RandomnessRequest.round)
   */
  staleRequestTimeout = GlobalState<arc4.UintN64>({
    key: 'staleRequestTimeout',
  })

  /* total number of pending requests, useful for limiting load on the contract */
  totalPendingRequests = GlobalState<arc4.UintN64>({ key: 'totalPendingRequests', initialValue: new arc4.UintN64(0) })

  /**
   *
   * Deletes a requests box and decrements the totalPendingRequests
   * @param requestId request to delete
   */
  private deleteRequest(requestId: arc4.UintN64): void {
    // decrement pending requests
    this.totalPendingRequests.value = new arc4.UintN64(this.totalPendingRequests.value.native - 1)
    // delete the box
    this.requests(requestId).delete()
  }

  /**
   * Gets and increments the next request ID
   * @returns the next available request ID
   * @description increments the nextRequestId global state + 1
   */
  private getNextRequestId(): arc4.UintN64 {
    // get the current value
    const requestId = this.nextRequestId.value
    // increment on global state
    this.nextRequestId.value = new arc4.UintN64(requestId.native + 1)

    return requestId
  }

  /**
   * Called upon application creation
   * @param publicKey the public key used to verify VRF proofs we will accept
   * @param maxPendingRequests the maximum number of pending requests allowed at any time
   * @param maxFutureRounds the maximum round in the future a request can be targeted
   * @param staleRequestTimeout the number of rounds after the target round a request can be cancelled
   */
  createApplication(
    publicKey: arc4.StaticBytes<32>,
    maxPendingRequests: arc4.UintN64,
    maxFutureRounds: arc4.UintN64,
    staleRequestTimeout: arc4.UintN64,
  ): void {
    // validate config params, publicKey is assumed to be valid
    assert(maxPendingRequests.native > 0, ERR_MAX_PENDING_REQUESTS_CANNOT_BE_ZERO)
    assert(maxFutureRounds.native > 0, ERR_MAX_FUTURE_ROUNDS_CANNOT_BE_ZERO)
    assert(staleRequestTimeout.native > 0, ERR_TIMEOUT_CANNOT_BE_ZERO)
    // store the public key we will accept verified proofs from
    this.publicKey.value = publicKey
    // store the max pending requests
    this.maxPendingRequests.value = maxPendingRequests
    // store the max future round
    this.maxFutureRounds.value = maxFutureRounds
    // store the stale request timeout
    this.staleRequestTimeout.value = staleRequestTimeout
  }

  // should not be enabled in production
  updateApplication(): void {
    this.onlyManager()
  }

  // delete app, pay manager back any remaining algos
  deleteApplication(): void {
    this.onlyManager()
    // cannot have any pending requests
    assert(this.totalPendingRequests.value.native === 0, ERR_NO_PENDING_REQUESTS)
    // send remaining algos back to the manager
    itxn
      .payment({
        closeRemainderTo: this.manager().native,
        note: NOTE_CLOSE_OUT_REMAINDER,
      })
      .submit()
  }

  /**
   *
   * @param requesterAddress who the request is on behalf of?
   * @param round the round to request the randomness for
   * @param costsPayment payment covering txnFees + boxCost
   * @returns a unique request ID to be used to identify the request
   */
  public createRequest(
    requesterAddress: arc4.Address,
    round: arc4.UintN64,
    costsPayment: gtxn.PaymentTxn,
  ): arc4.UintN64 {
    // when not paused, users can create new requests
    this.whenNotPaused()
    // ensure there is capacity for more pending requests
    assert(this.totalPendingRequests.value.native < this.maxPendingRequests.value.native, ERR_MAX_PENDING_REQUESTS)
    // ensure the requested round is in the future
    assert(round.native > Global.round, ERR_MUST_BE_FUTURE_ROUND)
    // ensure the requested round is within the allowed future round limit
    assert(round.native <= Global.round + this.maxFutureRounds.value.native, 'error: round exceeds max future round')
    // get caller app id
    const callerAppId = Global.callerApplicationId
    // this method should only be callable by app inner txns
    assert(callerAppId !== 0, ERR_MUST_BE_CALLED_FROM_APP)
    // get fees and costs
    const [txnFees, boxCost] = this.getCosts().native

    // ensure costsPayment covers fees and boxcost
    assertMatch(
      costsPayment,
      {
        receiver: Global.currentApplicationAddress,
        amount: {
          // should cover the required fees + box storage cost (will be refunded)
          greaterThanEq: txnFees.native + boxCost.native,
        },
      },
      ERR_COSTS_PAYMENT_MUST_BE_VALID,
    )

    // calc fees paid = total - boxCost
    const feesPaid: uint64 = costsPayment.amount - boxCost.native

    const request = new RandomnessRequest({
      createdAt: new arc4.UintN64(Global.round),
      requesterAppId: new arc4.UintN64(callerAppId),
      requesterAddress: requesterAddress,
      round: round,
      feePaid: new arc4.UintN64(feesPaid),
      boxCost: boxCost,
    })

    // get next available requestId
    const requestId = this.getNextRequestId()
    // store request in box
    this.requests(requestId).value = request.copy()
    // increment the total pending requests
    this.totalPendingRequests.value = new arc4.UintN64(this.totalPendingRequests.value.native + 1)

    // emit event
    emit(
      new RequestCreated({
        requestId: requestId,
        requesterAppId: new arc4.UintN64(callerAppId),
        requesterAddress: requesterAddress,
        round: round,
      }),
    )
    // return id to caller
    return requestId
  }

  public cancelRequest(requestId: arc4.UintN64): void {
    // get value from the box
    const request: RandomnessRequest = this.requests(requestId).value.copy()
    // cannot cancel until >= (request.round + staleRequestTimeout)
    assert(Global.round >= request.round.native + this.staleRequestTimeout.value.native, ERR_REQUEST_MUST_BE_STALE)

    let amountToRefund: uint64 = request.boxCost.native + request.feePaid.native

    // if the caller is not the requester, pay them the cost of cancellation
    if (request.requesterAddress.native !== Txn.sender) {
      // 1 app call
      // 2 itxn 1 (caller receiving fees)
      // 3 itxn 2 (mbr refund/remaining fees to requester)

      // txn sender should get the fee's reembursed
      const cancellationFees: uint64 = Global.minTxnFee * 3

      // deduct cancellation fees from total amount
      amountToRefund -= cancellationFees

      // send the caller back the cost of the cancellation
      itxn
        .payment({
          receiver: Txn.sender,
          amount: cancellationFees,
          note: NOTE_CANCEL_PAYMENT,
          fee: 0,
        })
        .submit()
    }

    // refund the box cost fee paid to the requester
    itxn
      .payment({
        receiver: request.requesterAddress.native,
        amount: amountToRefund,
        note: NOTE_BOX_MBR_REFUND, // TODO: make a new note that explains this better
        fee: 0, // force group to cover it
      })
      .submit()

    // emit cancelled event
    emit(
      new RequestCancelled({
        requestId: requestId,
        requesterAppId: request.requesterAppId,
        requesterAddress: request.requesterAddress,
      }),
    )

    this.deleteRequest(requestId)
  }

  /**
   *
   * @param requestId the ID of the VRF request
   * @param proof the VRF proof output using the `targetRound` block seed of the targeted RandomnessBeaconRequest
   */
  public completeRequest(requestId: arc4.UintN64, proof: arc4.StaticBytes<80>): void {
    // only allow the manager to call, they should be only one with access to private key
    this.onlyManager()
    // get request from the box
    const request: RandomnessRequest = this.requests(requestId).value.copy()
    // get block seed of the target round
    const blockSeed = op.Block.blkSeed(request.round.native)
    // increase opcode budget using app account balance (should be pre-funded by the caller to cover this cost)
    ensureBudget(5700, OpUpFeeSource.GroupCredit)
    // verify vrf proof
    const [output, verified] = op.vrfVerify(VrfVerify.VrfAlgorand, blockSeed, proof.bytes, this.publicKey.value.bytes)
    // must be verified
    assert(verified, ERR_PROOF_MUST_BE_VALID)

    // call the callback function of the caller app
    const r = arc4.abiCall(RandomnessBeaconCallerStub.prototype.fulfillRandomness, {
      appId: request.requesterAppId.native,
      args: [requestId, request.requesterAddress, new arc4.StaticBytes<64>(output)],
      fee: 0,
    })

    // refund feePaid to the Caller so they get reembursed (as they paid the fees for this group)
    itxn
      .payment({
        receiver: Txn.sender,
        amount: request.feePaid.native,
        note: NOTE_FEES_PAYMENT,
        fee: 0,
      })
      .submit()

    // refund the box cost fee paid to the Requester (can differ from the Caller who receives the fees)
    itxn
      .payment({
        receiver: request.requesterAddress.native,
        amount: request.boxCost.native,
        note: NOTE_BOX_MBR_REFUND,
        fee: 0,
      })
      .submit()

    // dispatch fulfilled event
    emit(
      new RequestFulfilled({
        requestId: requestId,
        requesterAppId: request.requesterAppId,
        requesterAddress: request.requesterAddress,
      }),
    )

    // delete the box
    this.deleteRequest(requestId)
  }

  /**
   *
   * Convenience function to get associated costs with using the beacon service
   * @returns arc4.Tuple<[txnFees, boxCost] - tuple of the required txn fees and box cost (that will be refunded)
   */
  @abimethod({ readonly: true })
  public getCosts(): arc4.Tuple<[arc4.UintN64, arc4.UintN64]> {
    // 8x the normal txn budget to use vrf_verify alone
    // 2 inner txns, fees to caller and box refund to requeste
    // 1x app call txn (base external txn)
    // 1x app call itxn to call fulfillRandomness (from Beacon app)
    // ... if there is any more fees, user should cover them (potential)
    // 0.012 * minTxnFee base cost from the ap
    const numRequiredTxns: uint64 = 8 + 2 + 1 + 1
    // work out required fee
    const txnFees: uint64 = Global.minTxnFee * numRequiredTxns

    // just create a dummy request to calculate the mbr cost
    const fakeRequest = new RandomnessRequest({
      createdAt: new arc4.UintN64(0),
      requesterAppId: new arc4.UintN64(0),
      requesterAddress: new arc4.Address(Global.zeroAddress),
      round: new arc4.UintN64(0),
      feePaid: new arc4.UintN64(0),
      boxCost: new arc4.UintN64(0),
    })

    const keySize: uint64 = this.requests.keyPrefix.length + new arc4.UintN64(0).bytes.length
    const boxSize: uint64 = fakeRequest.bytes.length

    const boxCost: uint64 = BOX_CREATE_COST + BOX_BYTE_COST * (keySize + boxSize)

    return new arc4.Tuple(new arc4.UintN64(txnFees), new arc4.UintN64(boxCost))
  }
}
