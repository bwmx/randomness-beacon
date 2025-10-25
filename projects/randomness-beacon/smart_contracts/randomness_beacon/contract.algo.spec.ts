import {
  arc4,
  assert,
  assertMatch,
  Bytes,
  Global,
  gtxn,
  op,
  uint64,
  Uint64,
} from '@algorandfoundation/algorand-typescript'
import { ApplicationSpy, TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RandomnessBeacon } from './contract.algo'
import { ExampleCaller } from './contracts/example-caller.algo'
import { RandomnessRequest } from './types.algo'

import libvrf from '../../../libvrf'

describe('RandomnessBeacon contract', () => {
  const ctx = new TestExecutionContext()

  beforeAll(async () => {
    await libvrf.init()
  })

  afterEach(() => {
    ctx.reset()
  })

  const deploy = (maxPendingRequests: bigint, maxFutureRound: bigint, staleRequestTimeout: bigint) => {
    const beaconContract = ctx.contract.create(RandomnessBeacon)

    const beaconApp = ctx.ledger.getApplicationForContract(beaconContract)

    // generate vrf keypair to be used
    const { publicKey, secretKey } = libvrf.keypair()

    beaconContract.createApplication(
      new arc4.StaticBytes<32>(Bytes(publicKey)),
      new arc4.UintN64(maxPendingRequests), // max pending requests
      new arc4.UintN64(maxFutureRound), // max future round
      new arc4.UintN64(staleRequestTimeout), // stale request timeout
    )

    // create new application spy
    const spy = new ApplicationSpy(RandomnessBeacon)

    spy.on.createRequest((itxnContext) => {
      const round: uint64 = arc4.decodeArc4(itxnContext.appArgs(2))
      // const requesterAddress: string = arc4.decodeArc4(itxnContext.appArgs(1))
      const requesterAddress = Global.zeroAddress
      const costsPayment: gtxn.PaymentTxn = itxnContext.itxns![0] as any

      // ensure there is capacity for more pending requests
      assert(
        beaconContract.totalPendingRequests.value.native < beaconContract.maxPendingRequests.value.native,
        'cannot exceed max pending requests',
      )
      // ensure the requested round is in the future
      assert(round > Global.round, 'requested round must be at least one round in the future')

      // get the costs
      const [txnFees, boxCost] = beaconContract.getCosts().native

      assertMatch(
        costsPayment,
        {
          receiver: beaconApp.address,
          amount: {
            // should cover the required fees + box storage cost (will be refunded)
            greaterThanEq: txnFees.native + boxCost.native,
          },
        },
        'must cover txn fees and box cost',
      )

      // calc fees paid = total - boxCost
      const feesPaid: uint64 = costsPayment.amount - boxCost.native

      // get next available request id
      const requestId = beaconContract.nextRequestId.value
      // inc current requestId
      beaconContract.nextRequestId.value = new arc4.UintN64(requestId.native + 1)

      const request = new RandomnessRequest({
        createdAt: new arc4.UintN64(Global.round),
        round: new arc4.UintN64(round),
        requesterAppId: new arc4.UintN64(Global.callerApplicationId), // TODO: test
        requesterAddress: new arc4.Address(requesterAddress), // TODO: make dummy addr to test
        feePaid: new arc4.UintN64(feesPaid),
        boxCost: boxCost,
      })

      // make request in box storage
      beaconContract.requests(requestId).value = request
      // increment the total pending requests
      beaconContract.totalPendingRequests.value = new arc4.UintN64(beaconContract.totalPendingRequests.value.native + 1)

      // ? emit event
      // emit(
      //   new RequestCreated({
      //     requestId: requestId,
      //     requesterAppId: new arc4.UintN64(callerAppId),
      //     requesterAddress: caller,
      //     round: round,
      //   }),
      // )

      itxnContext.setReturnValue(requestId)
    })

    spy.on.completeRequest((itxnContext) => {
      // workaround lack of vrfVerify in testing
      // just use libvrf instead

      // TODO: get from itxnContext
      const requestId = new arc4.UintN64(1)
      // TODO get from params
      const proof = undefined

      const request = beaconContract.requests(requestId).value

      const blockSeed = op.Block.blkSeed(request.round.native)

      const { output, result } = libvrf.verify(beaconContract.publicKey, proof, blockSeed)

      // call example app
      // TODO: fix properly
      // ExampleCaller.prototype.fulfillRandomness(
      //   requestId,
      //   request.requesterAddress,
      //   new arc4.StaticBytes<64>(Bytes(output)),
      // )
    })

    // add spy to test context
    ctx.addApplicationSpy(spy)

    return { beaconContract, beaconApp, publicKey, secretKey }
  }

  it('Can be created and global state is as expected', () => {
    const { beaconContract, publicKey } = deploy(10n, 100n, 1000n)

    // check global state is as expected
    expect(beaconContract.publicKey.value.native).toStrictEqual(Bytes(publicKey))
    expect(beaconContract.nextRequestId.value).toStrictEqual(new arc4.UintN64(1))
    expect(beaconContract.totalPendingRequests.value).toStrictEqual(new arc4.UintN64(0))
    expect(beaconContract.maxPendingRequests.value).toStrictEqual(new arc4.UintN64(10n))
    expect(beaconContract.maxFutureRounds.value).toStrictEqual(new arc4.UintN64(100n))
    expect(beaconContract.staleRequestTimeout.value).toStrictEqual(new arc4.UintN64(1000n))
  })

  it('can call createRequest', () => {
    const { beaconContract, beaconApp } = deploy(10n, 100n, 1000n)

    // make contract
    const exampleCallerContract = ctx.contract.create(ExampleCaller)
    // create application
    exampleCallerContract.createApplication(beaconApp)
    // get handle to app on ledger
    const exampleCallerApp = ctx.ledger.getApplicationForContract(exampleCallerContract)

    // generate new a new account to represent the requester
    const requesterAddress = ctx.any.account()

    const [txnFees, boxCost] = beaconContract.getCosts().native

    console.log('txnFees: ' + txnFees.native.toString())
    console.log('boxCost: ' + boxCost.native.toString())
    // send to the caller app (this will pay beacon on our behalf)
    const costPayment = ctx.any.txn.payment({
      sender: requesterAddress,
      receiver: exampleCallerApp.address,
      amount: txnFees.native + boxCost.native,
    })

    const r = exampleCallerContract.test1(costPayment)

    const requestId = r.at(0)
    const targetRound = r.at(1)

    // should be a future round
    expect(BigInt(targetRound.native)).toBeGreaterThanOrEqual(BigInt(Global.round))
    // should always be 1, we're the first request
    expect(requestId.native).toEqual(Uint64(1))
    // same as above, should equal zero
    expect(beaconContract.totalPendingRequests.value.native).toEqual(Uint64(1))
    // TODO: verify box on the beacon app exists under the pending requestId
  })

  it('Can call completeRequest()', () => {
    const { beaconContract, beaconApp, secretKey } = deploy(10n, 100n, 1000n)

    const exampleCallerContract = ctx.contract.create(ExampleCaller)

    // create application
    exampleCallerContract.createApplication(beaconApp)

    // get handle to app on ledger
    const exampleCallerApp = ctx.ledger.getApplicationForContract(exampleCallerContract)

    const [txnFees, boxCost] = beaconContract.getCosts().native

    const feePayment = ctx.any.txn.payment({
      receiver: exampleCallerApp.address,
      amount: txnFees.native + boxCost.native,
    })

    const [requestId, round] = exampleCallerContract.test1(feePayment).native

    console.log('ret = ', requestId.native, round.native)

    // patch round 7 with some dummy seeed data
    ctx.ledger.patchBlockData(round.native, {
      seed: Bytes('woo'),
    })

    // however block 7 is not set
    const blockSeed = op.Block.blkSeed(7)

    // create the proof
    const { proof, result } = libvrf.prove(secretKey, blockSeed.toString())
    // result 0 === success, must be proven succesfully
    expect(result).toEqual(0)

    // todo: mock completeRequest, verify the proof in there and proceed... vrfVerify unavailable in testing
    //beaconContract.completeRequest(requestId, new arc4.StaticBytes<80>(Bytes(proof)))
  })
})
