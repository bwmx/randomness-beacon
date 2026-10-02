import {
  Application,
  arc4,
  BoxMap,
  clone,
  emit,
  ensureBudget,
  Global,
  GlobalState,
  gtxn,
  itxn,
  loggedAssert,
  op,
  OpUpFeeSource,
  readonly,
  TemplateVar,
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
  ERR_CALLER_NOT_APP,
  ERR_CAPACITY_EXHAUSTED,
  ERR_INVALID_PAYMENT,
  ERR_INVALID_PROOF,
  ERR_NO_REQUESTS_FOR_ROUND,
  ERR_NOT_REQUESTER_APP,
  ERR_NOT_STALE,
  ERR_NOT_UPDATABLE,
  ERR_REQUESTS_PENDING,
  ERR_ROUND_NOT_FUTURE,
  ERR_ROUND_NOT_PROVEN,
  ERR_ROUND_PROVEN,
  ERR_ROUND_TOO_FAR,
  ERR_SEED_UNAVAILABLE,
  ERR_UNKNOWN_REQUEST,
  ERR_ZERO_MAX_FUTURE_ROUNDS,
  ERR_ZERO_MAX_PENDING_REQUESTS,
  ERR_ZERO_STALE_TIMEOUT,
  NOTE_BOX_MBR_REFUND,
  NOTE_CLOSE_OUT_REMAINDER,
  NOTE_FEES_PAYMENT,
  NOTE_PROOF_FEES_PAYMENT,
  RandomnessBeaconRequesterStub,
  RandomnessRequest,
  RandomnessRequestCosts,
  RequestCancelled,
  RequestCreated,
  RequestFulfilled,
  RoundProven,
  RoundState,
  VrfProof,
  VrfPublicKey,
} from './types.algo'

/* opcodes vrf_verify needs */
const VRF_BUDGET: uint64 = 5700
/* prepaid per request for submitProof: app call + up to 8 op-up inner calls for vrf_verify + proof fee payment */
const PROOF_TXNS: uint64 = 10
/* fulfillRequest: app call + callback inner call + fee payment + box deposit refund */
const FULFILL_TXNS: uint64 = 4

export class RandomnessBeacon extends classes(Managable, Pausable) implements arc4.ConventionalRouting {
  /* the public key used to verify VRF proofs */
  publicKey = GlobalState<VrfPublicKey>({ key: 'publicKey' })

  /* the next requestId index, useful for tracking. set to 1 initially */
  nextRequestId = GlobalState<uint64>({ key: 'nextRequestId', initialValue: 1 })

  /* box map of randomness requests */
  requests = BoxMap<uint64, RandomnessRequest>({ keyPrefix: 'requests' })

  /* box map of target rounds with pending requests, holding each round's proven output */
  rounds = BoxMap<uint64, RoundState>({ keyPrefix: 'rounds' })

  /**
   * Max rounds in the future ([current round] + maxFutureRounds) allowed for requests
   */
  maxFutureRounds = GlobalState<uint64>({
    key: 'maxFutureRounds',
  })

  /**
   * Max number of pending requests allowed
   */
  maxPendingRequests = GlobalState<uint64>({
    key: 'maxPendingRequests',
  })

  /**
   * Stale request timeout in rounds (after which a request can be cancelled after RandomnessRequest.round)
   */
  staleRequestTimeout = GlobalState<uint64>({
    key: 'staleRequestTimeout',
  })

  /* total number of pending requests, useful for limiting load on the contract */
  totalPendingRequests = GlobalState<uint64>({ key: 'totalPendingRequests', initialValue: 0 })

  /* number of rounds ever proven: lets relayers notice a proof without re-reading round boxes */
  totalProofs = GlobalState<uint64>({ key: 'totalProofs', initialValue: 0 })

  /**
   * Deletes a requests box, decrements the totalPendingRequests and releases the request's round box share
   * @param requestId request to delete
   * @param round the request's target round
   * @param withdrawnProofFee proof fee leaving the round's proofFees (cancellation refunds it)
   */
  private _deleteRequest(requestId: uint64, round: uint64, withdrawnProofFee: uint64): void {
    // decrement pending requests
    this.totalPendingRequests.value -= 1
    // delete the box
    this.requests(requestId).delete()
    // the last request for a round deletes the round box, freeing its deposit for this request's refund
    const state = clone(this.rounds(round).value)
    if (state.pending === 1) {
      this.rounds(round).delete()
    } else {
      this.rounds(round).value = {
        pending: state.pending - 1,
        proofFees: state.proofFees - withdrawnProofFee,
        proofCost: state.proofCost,
        output: state.output,
      }
    }
  }

  /**
   * Gets and increments the next request ID
   * @returns the next available request ID
   * @description increments the nextRequestId global state + 1
   */
  private _getNextRequestId(): uint64 {
    // get the current value
    const requestId = this.nextRequestId.value
    // increment on global state
    this.nextRequestId.value += 1

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
    publicKey: VrfPublicKey,
    maxPendingRequests: uint64,
    maxFutureRounds: uint64,
    staleRequestTimeout: uint64,
  ): void {
    // validate config params, publicKey is assumed to be valid
    loggedAssert(maxPendingRequests > 0, ERR_ZERO_MAX_PENDING_REQUESTS)
    loggedAssert(maxFutureRounds > 0, ERR_ZERO_MAX_FUTURE_ROUNDS)
    loggedAssert(staleRequestTimeout > 0, ERR_ZERO_STALE_TIMEOUT)
    // store the public key we will accept verified proofs from
    this.publicKey.value = publicKey
    // store the max pending requests
    this.maxPendingRequests.value = maxPendingRequests
    // store the max future round
    this.maxFutureRounds.value = maxFutureRounds
    // store the stale request timeout
    this.staleRequestTimeout.value = staleRequestTimeout
  }

  // Deploy-time flag (AlgoKit's TMPL_UPDATABLE): deploy-config makes localnet deploys updatable and
  // testnet/mainnet deploys immutable, so the manager can never swap the verification logic in production.
  updateApplication(): void {
    this.onlyManager()
    loggedAssert(TemplateVar<boolean>('UPDATABLE'), ERR_NOT_UPDATABLE)
  }

  // delete app, pay manager back any remaining algos
  deleteApplication(): void {
    this.onlyManager()
    // cannot have any pending requests
    loggedAssert(this.totalPendingRequests.value === 0, ERR_REQUESTS_PENDING)
    // send remaining algos back to the manager
    itxn
      .payment({
        closeRemainderTo: this.manager().native,
        note: NOTE_CLOSE_OUT_REMAINDER,
      })
      .submit()
  }

  /*
   * Internal function to create a request box and store the request
   */
  private _createRequest(request: RandomnessRequest): uint64 {
    // get next available requestId
    const requestId = this._getNextRequestId()
    // store request in box
    this.requests(requestId).value = clone(request)
    // increment the total pending requests
    this.totalPendingRequests.value += 1
    // return requestId
    return requestId
  }

  /**
   *
   * @param requesterAddress who the request is on behalf of?
   * @param round the round to request the randomness for
   * @param costsPayment payment covering txnFees + boxCost
   * @returns a unique request ID to be used to identify the request
   */
  public createRequest(requesterAddress: arc4.Address, round: uint64, costsPayment: gtxn.PaymentTxn): uint64 {
    // when not paused, users can create new requests
    this.whenNotPaused()
    // ensure there is capacity for more pending requests
    loggedAssert(this.totalPendingRequests.value < this.maxPendingRequests.value, ERR_CAPACITY_EXHAUSTED)
    // ensure the requested round is in the future
    loggedAssert(round > Global.round, ERR_ROUND_NOT_FUTURE)
    // ensure the requested round is within the allowed future round limit
    loggedAssert(round - Global.round <= this.maxFutureRounds.value, ERR_ROUND_TOO_FAR)
    // get caller app id
    const callerAppId = Global.callerApplicationId
    // this method should only be callable by app inner txns
    loggedAssert(callerAppId !== 0, ERR_CALLER_NOT_APP)
    // get minimimum expected fees and costs
    const { fees, boxMbr } = this.getCosts()
    // ensure costsPayment covers fees and boxcost (box storage cost will be refunded)
    loggedAssert(
      costsPayment.receiver === Global.currentApplicationAddress && costsPayment.amount >= fees + boxMbr,
      ERR_INVALID_PAYMENT,
    )

    // calc fees paid = total - boxCost
    const feesPaid: uint64 = costsPayment.amount - boxMbr
    // the proof fee goes to the round's prover, the rest of feesPaid to whoever fulfills this request
    const proofFee: uint64 = Global.minTxnFee * PROOF_TXNS

    // make this readonly
    const r: RandomnessRequest = {
      createdAt: Global.round,
      requesterAppId: callerAppId,
      requesterAddress: requesterAddress,
      round: round,
      costs: {
        fees: feesPaid,
        boxMbr: boxMbr,
      },
      proofFee: proofFee,
    }

    // join the round's pending requests; a future round cannot be proven yet, so its output is still zero
    if (this.rounds(round).exists) {
      const state = clone(this.rounds(round).value)
      this.rounds(round).value = {
        pending: state.pending + 1,
        proofFees: state.proofFees + proofFee,
        proofCost: 0,
        output: state.output,
      }
    } else {
      this.rounds(round).value = { pending: 1, proofFees: proofFee, proofCost: 0, output: op.bzero(64) }
    }

    // create new request, store box, update state etc
    const requestId = this._createRequest(r)

    // emit created event
    emit<RequestCreated>({
      requestId: requestId,
      requesterAppId: r.requesterAppId,
      requesterAddress: r.requesterAddress,
      round: r.round,
    })

    // return id to caller
    return requestId
  }

  /**
   * Only the requester app may cancel, so its pending state settles atomically with the refund.
   * Once the round is proven its outcome is public, so the request can only be fulfilled.
   */
  public cancelRequest(requestId: uint64): uint64 {
    loggedAssert(this.requests(requestId).exists, ERR_UNKNOWN_REQUEST)
    const request = clone(this.requests(requestId).value)
    loggedAssert(Global.callerApplicationId === request.requesterAppId, ERR_NOT_REQUESTER_APP)
    loggedAssert(
      Global.round > request.round && Global.round - request.round > this.staleRequestTimeout.value,
      ERR_NOT_STALE,
    )
    loggedAssert(this.rounds(request.round).value.output === op.bzero(64), ERR_ROUND_PROVEN)

    const refund: uint64 = request.costs.boxMbr + request.costs.fees
    this._deleteRequest(requestId, request.round, request.proofFee)
    itxn
      .payment({
        receiver: Application(request.requesterAppId).address,
        amount: refund,
        note: NOTE_BOX_MBR_REFUND,
        fee: 0,
      })
      .submit()
    emit<RequestCancelled>({
      requestId,
      requesterAppId: request.requesterAppId,
      requesterAddress: request.requesterAddress,
    })
    return refund
  }

  /**
   * Verifies the VRF proof of a round's block seed once for all of that round's requests and stores the output.
   * Anyone may relay a valid proof; the submitting account receives the round's prepaid proof fees.
   * @param round a target round with pending requests
   * @param proof the VRF proof of the round's block seed
   */
  public submitProof(round: uint64, proof: VrfProof): void {
    // only rounds that requests wait on, once (checked before paying for op-ups)
    loggedAssert(this.rounds(round).exists, ERR_NO_REQUESTS_FOR_ROUND)
    const state = clone(this.rounds(round).value)
    loggedAssert(state.output === op.bzero(64), ERR_ROUND_PROVEN)
    // the AVM reads a block seed only for LastValid - 1002 < round < FirstValid
    loggedAssert(round < Txn.firstValid && Txn.lastValid - round < 1002, ERR_SEED_UNAVAILABLE)
    // get block seed of the target round
    const blockSeed = op.Block.blkSeed(round)
    // Increase opcode budget using the caller's pooled transaction fees. Budget from other app calls in the group
    // (such as grouped fulfillments) is used first, so this often needs fewer than 8 op-up calls, or none.
    const budgetBefore = Global.opcodeBudget
    ensureBudget(VRF_BUDGET, OpUpFeeSource.GroupCredit)
    // each op-up adds 700; the opcodes spent between the two reads stay well under one op-up
    const opUps: uint64 = (Global.opcodeBudget + 699 - budgetBefore) / 700
    // verify vrf proof
    const [output, verified] = op.vrfVerify(VrfVerify.VrfAlgorand, blockSeed, proof, this.publicKey.value)
    // must be verified
    loggedAssert(verified, ERR_INVALID_PROOF)

    // Reimburse what proving cost (this call, its op-ups and this payment), at most what the requests prepaid;
    // they get the rest back pro rata when fulfilled.
    const spent: uint64 = Global.minTxnFee * (opUps + 2)
    const proofCost: uint64 = spent < state.proofFees ? spent : state.proofFees
    this.rounds(round).value = { pending: state.pending, proofFees: state.proofFees, proofCost, output }
    this.totalProofs.value += 1

    itxn
      .payment({
        receiver: Txn.sender,
        amount: proofCost,
        note: NOTE_PROOF_FEES_PAYMENT,
        fee: 0,
      })
      .submit()

    emit<RoundProven>({ round: round, vrfOutput: output })
  }

  /**
   * Delivers a request's randomness once its round is proven. Needs no VRF key: anyone may call it, and the
   * submitting account receives the request's prepaid fulfillment fee. A failing callback leaves it pending.
   * @param requestId the ID of the VRF request
   */
  public fulfillRequest(requestId: uint64): void {
    // get request from the box
    loggedAssert(this.requests(requestId).exists, ERR_UNKNOWN_REQUEST)
    const request: RandomnessRequest = clone(this.requests(requestId).value)
    const state = clone(this.rounds(request.round).value)
    const output = state.output
    loggedAssert(output !== op.bzero(64), ERR_ROUND_NOT_PROVEN)
    // this request's share of the proof fees its round prepaid but did not spend
    const proofRefund: uint64 = (request.proofFee * (state.proofFees - state.proofCost)) / state.proofFees
    // Bind the shared round output to this request; every input is fixed when the request is created.
    const randomness = op.sha256(
      output
        .concat(op.itob(Global.currentApplicationId.id))
        .concat(op.itob(requestId))
        .concat(op.itob(request.requesterAppId))
        .concat(request.requesterAddress.bytes),
    )

    arc4.abiCall<typeof RandomnessBeaconRequesterStub.prototype.fulfillRandomness>({
      appId: request.requesterAppId,
      args: [requestId, request.requesterAddress, randomness],
      fee: 0,
    })

    // Pay the prepaid fulfillment fee to the relayer that successfully completes this request.
    itxn
      .payment({
        receiver: Txn.sender,
        amount: request.costs.fees - request.proofFee,
        note: NOTE_FEES_PAYMENT,
        fee: 0,
      })
      .submit()

    // Release storage before refunding the requester app; users claim from that app separately.
    this._deleteRequest(requestId, request.round, 0)
    itxn
      .payment({
        receiver: Application(request.requesterAppId).address,
        amount: request.costs.boxMbr + proofRefund,
        note: NOTE_BOX_MBR_REFUND,
        fee: 0,
      })
      .submit()

    // emit fulfilled event
    emit<RequestFulfilled>({
      requestId: requestId,
      requesterAppId: request.requesterAppId,
      requesterAddress: request.requesterAddress,
      randomness: randomness,
    })
  }

  /**
   *
   * Convenience function to get associated costs with using the beacon service
   * @returns RandomnessRequestCosts object containing fees and boxMbr costs
   */
  @readonly
  public getCosts(): RandomnessRequestCosts {
    // each request prepays a share of its round's proof (paid in full even when it shares the round) and its
    // own fulfillment; any more fees (e.g. a heavier callback) the user should cover by overpaying
    const txnFees: uint64 = Global.minTxnFee * (PROOF_TXNS + FULFILL_TXNS)
    const requestBox: uint64 =
      BOX_CREATE_COST +
      BOX_BYTE_COST * (this.requests.keyPrefix.length + arc4.sizeOf<uint64>() + arc4.sizeOf<RandomnessRequest>())
    // every request deposits a whole round box; the last request for its round frees the one actually used
    const roundBox: uint64 =
      BOX_CREATE_COST +
      BOX_BYTE_COST * (this.rounds.keyPrefix.length + arc4.sizeOf<uint64>() + arc4.sizeOf<RoundState>())

    return { fees: txnFees, boxMbr: requestBox + roundBox }
  }
}
