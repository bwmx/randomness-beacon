import { arc4, assert, assertMatch, emit, Global, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
import { ApplicationSpy, TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RandomnessBeacon } from './contract.algo'
import { ExampleCaller } from './contracts/example-caller.algo'

import libvrf from '../../../libvrf'
import { RandomnessRequest, RequestCreated, VrfPublicKey } from './types.algo'

describe('RandomnessBeacon contract', () => {
  const ctx = new TestExecutionContext()
  let exampleCallerAppId: uint64 = 0

  beforeAll(async () => {
    await libvrf.init()
  })

  afterEach(() => {
    ctx.reset()
    exampleCallerAppId = 0
  })

  const deploy = (maxPendingRequests: uint64, maxFutureRound: uint64, staleRequestTimeout: uint64) => {
    const beaconContract = ctx.contract.create(RandomnessBeacon)

    const beaconApp = ctx.ledger.getApplicationForContract(beaconContract)

    // generate vrf keypair to be used
    const { publicKey, secretKey } = libvrf.keypair()

    beaconContract.createApplication(
      publicKey.buffer as any as VrfPublicKey,
      maxPendingRequests, // max pending requests
      maxFutureRound, // max future round
      staleRequestTimeout, // stale request timeout
    )

    // create new application spy
    const spy = new ApplicationSpy(RandomnessBeacon)

    spy.on.createRequest((itxnContext) => {
      const round: uint64 = arc4.decodeArc4(itxnContext.appArgs(2))
      const requesterAddress: arc4.Address = arc4.decodeArc4(itxnContext.appArgs(1))
      const costsPayment: gtxn.PaymentTxn = itxnContext.itxns![0] as any

      // ensure there is capacity for more pending requests
      assert(
        beaconContract.totalPendingRequests.value < beaconContract.maxPendingRequests.value,
        'cannot exceed max pending requests',
      )
      // ensure the requested round is in the future
      assert(round > Global.round, 'requested round must be at least one round in the future')

      // get the costs
      const { fees, boxMbr } = beaconContract.getCosts()
      // check the costs payment covers required fees + box mbr
      assertMatch(
        costsPayment,
        {
          receiver: beaconApp.address,
          amount: {
            // should cover the required fees + box storage cost (will be refunded)
            greaterThanEq: fees + boxMbr,
          },
        },
        'must cover txn fees and box cost',
      )

      // calc fees paid = total - boxCost
      const feesPaid: uint64 = costsPayment.amount - boxMbr

      // get next available request id
      const requestId = beaconContract.nextRequestId.value
      // inc current requestId
      beaconContract.nextRequestId.value += 1

      const request: RandomnessRequest = {
        createdAt: Global.round,
        round: round,
        requesterAppId: exampleCallerAppId,
        requesterAddress: requesterAddress,
        costs: {
          fees: feesPaid,
          boxMbr: boxMbr,
        },
      }

      // make request in box storage
      beaconContract.requests(requestId).value = request
      // increment the total pending requests
      beaconContract.totalPendingRequests.value += 1

      //  emit created event
      emit<RequestCreated>({
        requestId: requestId,
        requesterAppId: Global.callerApplicationId,
        requesterAddress: requesterAddress,
        round: round,
      })

      itxnContext.setReturnValue(requestId)
    })

    // TODO: fix completeRequest spy see below commented test also
    // spy.on.completeRequest((itxnContext) => {
    //   // workaround lack of vrfVerify in testing
    //   // just use libvrf instead

    //   // TODO: get from itxnContext
    //   const requestId: uint64 = 1
    //   // TODO get from params
    //   const proof = undefined

    //   const request = beaconContract.requests(requestId).value

    //   const blockSeed = op.Block.blkSeed(request.round)

    //   const { output, result } = libvrf.verify(beaconContract.publicKey, proof, blockSeed)

    //   // call example app
    //   // TODO: fix properly
    //   // ExampleCaller.prototype.fulfillRandomness(
    //   //   requestId,
    //   //   request.requesterAddress,
    //   //   new arc4.StaticBytes<64>(Bytes(output)),
    //   // )
    // })

    // add spy to test context
    ctx.addApplicationSpy(spy)

    return { beaconContract, beaconApp, publicKey, secretKey }
  }

  it('Can be created and global state is as expected', () => {
    const { beaconContract, publicKey } = deploy(10, 100, 1000)

    // check global state is as expected
    expect(beaconContract.publicKey.value).toStrictEqual(publicKey.buffer)
    expect(beaconContract.nextRequestId.value).toStrictEqual(1)
    expect(beaconContract.totalPendingRequests.value).toStrictEqual(0)
    expect(beaconContract.maxPendingRequests.value).toStrictEqual(10)
    expect(beaconContract.maxFutureRounds.value).toStrictEqual(100)
    expect(beaconContract.staleRequestTimeout.value).toStrictEqual(1000)
  })

  it('can call createRequest', () => {
    const { beaconContract, beaconApp } = deploy(10, 100, 1000)
    // make contract
    const exampleCallerContract = ctx.contract.create(ExampleCaller)
    // create application
    exampleCallerContract.createApplication(beaconApp)
    // get handle to app on ledger
    const exampleCallerApp = ctx.ledger.getApplicationForContract(exampleCallerContract)
    // generate new a new account to represent the requester
    const requesterAddress = ctx.any.account()

    const { fees, boxMbr } = beaconContract.getCosts()

    // send to the caller app (this will pay beacon on our behalf)
    const costPayment = ctx.any.txn.payment({
      sender: requesterAddress,
      receiver: exampleCallerApp.address,
      amount: fees + boxMbr,
    })

    // set for test so ApplicationSpy hooks know
    exampleCallerAppId = exampleCallerApp.id

    // call test1 method, get a requestid and target round in return
    const [requestId, targetRound] = exampleCallerContract.test1(costPayment)

    // should be a future round
    expect(BigInt(targetRound)).toBeGreaterThanOrEqual(BigInt(Global.round))
    // should always be 1, we're the first request
    expect(requestId).toEqual(1)
    // same as above, should equal zero
    expect(beaconContract.totalPendingRequests.value).toEqual(1)
    // verify box on the beacon app exists under the pending requestId
    const storedRequest = beaconContract.requests(requestId).value

    // check everything stored correctly
    expect(BigInt(storedRequest.createdAt)).toBeLessThan(BigInt(Global.round))
    expect(storedRequest.requesterAppId).toEqual(exampleCallerApp.id)
    expect(storedRequest.requesterAddress.native).toEqual(requesterAddress)
    expect(storedRequest.round).toEqual(targetRound)
    expect(storedRequest.costs.fees).toEqual(fees)
    expect(storedRequest.costs.boxMbr).toEqual(boxMbr)
  })

  // TODO: fix test, ApplicationSpy not working as expected
  // it('Can call completeRequest()', () => {
  //   const { beaconContract, beaconApp, secretKey } = deploy(10, 100, 1000)

  //   const exampleCallerContract = ctx.contract.create(ExampleCaller)

  //   // create application
  //   exampleCallerContract.createApplication(beaconApp.id)

  //   // get handle to app on ledger
  //   const exampleCallerApp = ctx.ledger.getApplicationForContract(exampleCallerContract)

  //   const { fees, boxMbr } = beaconContract.getCosts()

  //   const feePayment = ctx.any.txn.payment({
  //     receiver: exampleCallerApp.address,
  //     amount: fees + boxMbr,
  //   })

  //   const [requestId, round] = exampleCallerContract.test1(feePayment)

  //   console.log('ret = ', requestId, round)

  //   // patch round 7 with some dummy seeed data
  //   ctx.ledger.patchBlockData(round, {
  //     seed: bzero(32),
  //   })

  //   // however block 7 is not set
  //   const blockSeed = op.Block.blkSeed(7)

  //   // create the proof
  //   const { proof, result } = libvrf.prove(secretKey, blockSeed.toString())
  //   // result 0 === success, must be proven succesfully
  //   expect(result).toEqual(0)

  //   // todo: mock completeRequest, verify the proof in there and proceed... vrfVerify unavailable in testing
  //   //beaconContract.completeRequest(requestId, new arc4.StaticBytes<80>(Bytes(proof)))
  // })
})
