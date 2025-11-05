import {
  arc4,
  assert,
  assertMatch,
  Bytes,
  bytes,
  emit,
  Global,
  gtxn,
  op,
  uint64,
  VrfVerify,
} from '@algorandfoundation/algorand-typescript'
import { ApplicationSpy, TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, beforeAll, describe, expect, it, Mock, vi } from 'vitest'
import { RandomnessBeacon } from './contract.algo'
import { ExampleCaller } from './contracts/example-caller.algo'

import libvrf from '../../../libvrf'
import { RandomnessRequest, RequestCreated, VrfOutput, VrfProof, VrfPublicKey } from './types.algo'

// Mock the op module from algorand-typescript, not the testing library
vi.mock(import('@algorandfoundation/algorand-typescript-testing/internal'), async (importOriginal) => {
  const mod: any = await importOriginal()

  return {
    ...mod,
    op: {
      ...mod.op,
      vrfVerify: vi.fn(),
    },
  }
})

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
    // make creator account
    const creatorAccount = ctx.any.account()
    // set default sender
    ctx.defaultSender = creatorAccount

    const beaconContract = ctx.contract.create(RandomnessBeacon)

    const beaconApp = ctx.ledger.getApplicationForContract(beaconContract)

    // generate vrf keypair to be used
    const { publicKey, secretKey } = libvrf.keypair()

    beaconContract.createApplication(
      publicKey as any as VrfPublicKey,
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
      const requestId: uint64 = beaconContract.nextRequestId.value
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
        requesterAppId: exampleCallerAppId,
        requesterAddress: requesterAddress,
        round: round,
      })

      itxnContext.setReturnValue(requestId)
    })

    //TODO: fix completeRequest spy see below commented test also
    // spy.on.completeRequest((itxnContext) => {
    //   console.log('hi')

    //   // workaround lack of vrfVerify in testing
    //   // just use libvrf instead
    //   const requestId: uint64 = arc4.decodeArc4(itxnContext.appArgs(1))
    //   const proof: VrfProof = arc4.decodeArc4(itxnContext.appArgs(2))

    //   const request = beaconContract.requests(requestId).value

    //   const blockSeed = op.Block.blkSeed(request.round)

    //   const { output, result } = libvrf.verify(beaconContract.publicKey, proof, blockSeed)

    //   // TODO: call fulfillRandomness on the requester app
    //   // ommited due to ApplicationSpy not working as expected in tests
    // })

    // add spy to test context
    ctx.addApplicationSpy(spy)

    return { beaconContract, beaconApp, publicKey, secretKey, manager: creatorAccount }
  }

  it('Can be created and global state is as expected', () => {
    const { beaconContract, publicKey, manager } = deploy(10, 100, 1000)

    // check global state is as expected
    expect(beaconContract.manager().native).toStrictEqual(manager)
    expect(beaconContract.publicKey.value).toStrictEqual(publicKey)
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
    const requesterAccount = ctx.any.account()

    const { fees, boxMbr } = beaconContract.getCosts()

    // send to the caller app (this will pay beacon on our behalf)
    const costPayment = ctx.any.txn.payment({
      sender: requesterAccount,
      receiver: exampleCallerApp.address,
      amount: fees + boxMbr,
    })

    // set for test so ApplicationSpy hooks know
    exampleCallerAppId = exampleCallerApp.id

    // set default sender to requester
    ctx.defaultSender = requesterAccount

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
    expect(storedRequest.requesterAddress.native).toEqual(requesterAccount)
    expect(storedRequest.round).toEqual(targetRound)
    expect(storedRequest.costs.fees).toEqual(fees)
    expect(storedRequest.costs.boxMbr).toEqual(boxMbr)
  })

  // TODO: fix test, ApplicationSpy not working as expected, the hook never gets called
  it('Can call completeRequest()', () => {
    const { beaconContract, beaconApp, secretKey, manager } = deploy(10, 100, 1000)

    // create example caller contract
    const exampleCallerContract = ctx.contract.create(ExampleCaller)
    // create application (pass existing beacon app)
    exampleCallerContract.createApplication(beaconApp)
    // get handle to app on ledger
    const exampleCallerApp = ctx.ledger.getApplicationForContract(exampleCallerContract)
    // get costs
    const { fees, boxMbr } = beaconContract.getCosts()

    // make new account to represent requester
    const requesterAccount = ctx.any.account()

    // build fee payment
    const feePayment = ctx.any.txn.payment({
      sender: requesterAccount,
      receiver: exampleCallerApp.address,
      amount: fees + boxMbr,
    })

    // set for test so ApplicationSpy hooks know
    exampleCallerAppId = exampleCallerApp.id

    console.log('exampleCallerApp.address:', exampleCallerApp.address)

    // set default sender to requester
    ctx.defaultSender = requesterAccount

    // call test1 method, returns requestId and targetRound Tuple
    const [requestId, round] = exampleCallerContract.test1(feePayment)

    // check request created correctly
    const createdRequest = beaconContract.requests(requestId).value

    expect(BigInt(createdRequest.createdAt)).toBeLessThan(BigInt(Global.round))
    expect(createdRequest.requesterAppId).toStrictEqual(exampleCallerApp.id)
    expect(createdRequest.requesterAddress.native).toStrictEqual(requesterAccount)
    expect(createdRequest.round).toStrictEqual(round)
    expect(createdRequest.costs.fees).toStrictEqual(fees)
    expect(createdRequest.costs.boxMbr).toStrictEqual(boxMbr)

    console.log(`ExampleCaller.test1() result =  [requestId: ${requestId}, round: ${round}]`)

    // set round to the target round (so seed is available)
    ctx.ledger.patchGlobalData({
      round: round,
    })
    // patch target round with some dummy (empty seed data) [predictable]
    ctx.ledger.patchBlockData(round, {
      seed: Bytes('abcdefghijklmnopqrstuvwxyzabcdef') as bytes<32>,
    })

    const mockedVrfVerify = op.vrfVerify as Mock<typeof op.vrfVerify>

    mockedVrfVerify.mockImplementation(
      (
        s: VrfVerify,
        message: bytes,
        proof: bytes | bytes<80>,
        publicKey: bytes | bytes<32>,
      ): readonly [bytes<64>, boolean] => {
        //console.log(message)
        assert(s === VrfVerify.VrfAlgorand, 'unexpected vrf type in mock')

        console.log('vrfVerify mock implementation called')

        // console.log('message =', message)
        // console.log('proof =', proof)
        // console.log('publicKey =', publicKey)

        // const { output, result } = libvrf.verify(
        //   bytesToUint8Array(publicKey),
        //   bytesToUint8Array(proof),
        //   bytesToUint8Array(message),
        // )
        // // console.log(`output = ${output} result = ${result}`)

        // return [Bytes(output) as any as VrfOutput, Boolean(result === 0)]
        return [Bytes(new Uint8Array(64).fill(7)) as any as VrfOutput, true]
      },
    )

    // get block seed
    const blockSeed = op.Block.blkSeed(round)
    // create the proof
    const { proof, result } = libvrf.prove(secretKey, blockSeed.toString())
    // result 0 === success, must be proven succesfully
    expect(result).toEqual(0)

    // dummy call to test mock
    op.vrfVerify(VrfVerify.VrfAlgorand, blockSeed, Bytes(proof), beaconContract.publicKey.value)
    // expect mock to have been called (mock function always return true, and 64 bytes filled with 7)
    expect(mockedVrfVerify).toHaveReturnedWith([Bytes(new Uint8Array(64).fill(7)) as any as VrfOutput, true])

    // change default sender to manager to call completeRequest (onlyManager() is called)
    ctx.defaultSender = manager
    // todo: investigate error
    beaconContract.completeRequest(requestId, Bytes(proof) as any as VrfProof)
  })
})
