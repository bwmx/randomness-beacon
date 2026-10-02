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

import { generateKeyPair, init as initVrf, prove as proveVrf } from '@bwmx/algorand-vrf-utils-ts'
import { createHash } from 'node:crypto'
import { Randomness, RandomnessRequest, RequestCreated, VrfProof, VrfPublicKey } from './types.algo'

// Mock the op module from algorand-typescript, not the testing library
vi.mock(import('@algorandfoundation/algorand-typescript-testing/internal'), async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await importOriginal()

  return {
    ...mod,
    op: {
      ...mod.op,
      vrfVerify: vi.fn(),
    },
  }
})

// A round box output; test code must build it with toFixed, or the testing ledger stores it as dynamic bytes.
const roundOutput = (fill: number) => Bytes(new Uint8Array(64).fill(fill)).toFixed({ length: 64 })

describe('RandomnessBeacon contract', () => {
  const ctx = new TestExecutionContext()
  let exampleCallerAppId: uint64 = 0

  beforeAll(async () => {
    await initVrf()
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
    const { publicKey, secretKey } = generateKeyPair()

    beaconContract.createApplication(
      publicKey as unknown as VrfPublicKey,
      maxPendingRequests, // max pending requests
      maxFutureRound, // max future round
      staleRequestTimeout, // stale request timeout
    )

    // create new application spy
    const spy = new ApplicationSpy(RandomnessBeacon)

    spy.on.getCosts((itxnContext) => itxnContext.setReturnValue(beaconContract.getCosts()))

    spy.on.createRequest((itxnContext) => {
      const round: uint64 = arc4.decodeArc4(itxnContext.appArgs(2))
      const requesterAddress: arc4.Address = arc4.decodeArc4(itxnContext.appArgs(1))
      const costsPayment: gtxn.PaymentTxn = itxnContext.itxns![0] as unknown as gtxn.PaymentTxn

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
        requesterAppId: exampleCallerAppId,
        requesterAddress: requesterAddress,
        round: round,
        costs: {
          fees: feesPaid,
          boxMbr: boxMbr,
        },
        proofFee: 10_000,
      }

      // make request in box storage
      beaconContract.requests(requestId).value = request
      beaconContract.rounds(round).value = { pending: 1, proofFees: 10_000, proofCost: 0, output: roundOutput(0) }
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

    // get costs
    const { fees, boxMbr } = beaconContract.getCosts()
    // send to the caller app (this will pay beacon on our behalf)
    const costPayment = ctx.any.txn.payment({
      sender: requesterAccount,
      receiver: exampleCallerApp.address,
      amount: fees + boxMbr,
      closeRemainderTo: Global.zeroAddress,
      rekeyTo: Global.zeroAddress,
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

  it('Can call submitProof() then fulfillRequest()', () => {
    const { beaconContract, beaconApp, secretKey } = deploy(10, 100, 1000)
    // create example caller contract
    const exampleCallerContract = ctx.contract.create(ExampleCaller)
    // create application (pass existing beacon app)
    exampleCallerContract.createApplication(beaconApp)
    // get handle to app on ledger
    const exampleCallerApp = ctx.ledger.getApplicationForContract(exampleCallerContract)
    // make new account to represent requester
    const requesterAccount = ctx.any.account()
    // get costs
    const { fees, boxMbr } = beaconContract.getCosts()
    // build fee payment
    const feePayment = ctx.any.txn.payment({
      sender: requesterAccount,
      receiver: exampleCallerApp.address,
      amount: fees + boxMbr,
      closeRemainderTo: Global.zeroAddress,
      rekeyTo: Global.zeroAddress,
    })

    // set for test so ApplicationSpy hooks know
    exampleCallerAppId = exampleCallerApp.id

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
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        message: bytes,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        proof: bytes | bytes<80>,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        publicKey: bytes | bytes<32>,
      ): readonly [bytes<64>, boolean] => {
        //console.log(message)
        assert(s === VrfVerify.VrfAlgorand, 'unexpected vrf type in mock')

        console.log('vrfVerify mock implementation called')

        // is real verification really needed for these tests? probably not
        // console.log('message =', message)
        // console.log('proof =', proof)
        // console.log('publicKey =', publicKey)

        return [roundOutput(7), true]
      },
    )

    // get block seed
    const blockSeed = op.Block.blkSeed(round)
    // create the proof
    const blockSeedBytes = (blockSeed as unknown as { asUint8Array(): Uint8Array }).asUint8Array()
    const { proof } = proveVrf(secretKey, blockSeedBytes)

    // dummy call to test mock
    op.vrfVerify(VrfVerify.VrfAlgorand, blockSeed, Bytes(proof), beaconContract.publicKey.value)
    // expect mock to have been called (mock function always return true, and 64 bytes filled with 7)
    expect(mockedVrfVerify).toHaveReturnedWith([roundOutput(7), true])

    //create new application spy
    const spy = new ApplicationSpy(ExampleCaller)

    spy.on.fulfillRandomness((itxnContext) => {
      // byte[32] is static, so the argument is the raw randomness
      const output = itxnContext.appArgs(3) as unknown as Randomness
      // set the output in the requester contract
      exampleCallerContract.output.value = output
      // increment total fulfilled
      exampleCallerContract.totalFulfilled.value += 1
    })

    ctx.addApplicationSpy(spy)

    // A relayer unrelated to the manager or requester may submit the proof, and anyone may fulfill.
    ctx.defaultSender = ctx.any.account()
    expect(() => beaconContract.fulfillRequest(requestId)).toThrow('ERR:RoundNotProven')
    // the testing ledger creates no op-ups, so the measured proof cost is the call plus its payment
    ctx.ledger.patchGlobalData({ opcodeBudget: 700 })
    // the seed is readable only for LastValid - 1002 < round < FirstValid
    const submitProof = (firstValid: uint64, lastValid: uint64) =>
      ctx.txn
        .createScope([ctx.any.txn.applicationCall({ appId: beaconApp, firstValid, lastValid })])
        .execute(() => beaconContract.submitProof(round, Bytes(proof) as unknown as VrfProof))
    expect(() => submitProof(round, round + 10)).toThrow('ERR:SeedUnavailable')
    expect(() => submitProof(round + 1, round + 1002)).toThrow('ERR:SeedUnavailable')
    submitProof(round + 1, round + 1001)
    expect(beaconContract.rounds(round).value.output).toStrictEqual(roundOutput(7))
    expect(beaconContract.totalProofs.value).toEqual(1)
    expect(BigInt(beaconContract.rounds(round).value.proofCost)).toBe(2_000n)
    expect(() => submitProof(round + 1, round + 11)).toThrow('ERR:RoundProven')
    beaconContract.fulfillRequest(requestId)

    // the caller receives the round output bound to this request
    const raw = (value: unknown) => (value as { asUint8Array(): Uint8Array }).asUint8Array()
    const expected = createHash('sha256')
      .update(new Uint8Array(64).fill(7))
      .update(raw(op.itob(beaconApp.id)))
      .update(raw(op.itob(requestId)))
      .update(raw(op.itob(exampleCallerApp.id)))
      .update(raw(requesterAccount.bytes))
      .digest()
    expect(exampleCallerContract.totalFulfilled.value).toEqual(1)
    expect(exampleCallerContract.output.value).toStrictEqual(Bytes(expected))
    expect(beaconContract.requests(requestId).exists).toBe(false)
    expect(beaconContract.rounds(round).exists).toBe(false)
  })
  it('only the issuing app may cancel and receives the full unused funding', () => {
    const { beaconContract } = deploy(5, 100, 10)
    const requesterApp = ctx.any.application()
    beaconContract.requests(1).value = {
      createdAt: 1,
      requesterAppId: requesterApp.id,
      requesterAddress: new arc4.Address(ctx.any.account()),
      round: 2,
      costs: { fees: 19_000, boxMbr: 37_700 },
      proofFee: 10_000,
    }
    beaconContract.rounds(2).value = { pending: 1, proofFees: 10_000, proofCost: 0, output: roundOutput(0) }
    beaconContract.totalPendingRequests.value = 1
    ctx.ledger.patchGlobalData({ round: 100, callerApplicationId: 0 })
    expect(() => beaconContract.cancelRequest(1)).toThrow('ERR:NotRequesterApp')
    ctx.ledger.patchGlobalData({ callerApplicationId: ctx.any.application().id })
    expect(() => beaconContract.cancelRequest(1)).toThrow('ERR:NotRequesterApp')
    for (const round of [1, 2, 12]) {
      ctx.ledger.patchGlobalData({ callerApplicationId: requesterApp.id, round })
      expect(() => beaconContract.cancelRequest(1)).toThrow('ERR:NotStale')
    }
    ctx.ledger.patchGlobalData({ round: 100 })
    // a proven round's outcome is public, so its requests can only be fulfilled
    beaconContract.rounds(2).value = { pending: 1, proofFees: 0, proofCost: 0, output: roundOutput(7) }
    expect(() => beaconContract.cancelRequest(1)).toThrow('ERR:RoundProven')
    beaconContract.rounds(2).value = { pending: 1, proofFees: 10_000, proofCost: 0, output: roundOutput(0) }
    const refunded = beaconContract.cancelRequest(1)
    expect(BigInt(refunded)).toBe(56_700n)
    expect(beaconContract.requests(1).exists).toBe(false)
    expect(beaconContract.rounds(2).exists).toBe(false)
    expect(BigInt(beaconContract.totalPendingRequests.value)).toBe(0n)
  })

  it('example rejects unknown, mismatched, and replayed callbacks and validates payment fields', () => {
    const { beaconApp } = deploy(5, 100, 10)
    const example = ctx.contract.create(ExampleCaller)
    const app = ctx.ledger.getApplicationForContract(example)
    example.createApplication(beaconApp)
    const requester = ctx.any.account()
    ctx.defaultSender = requester
    const costsPayment = {
      sender: requester,
      receiver: app.address,
      amount: 49_700,
      closeRemainderTo: Global.zeroAddress,
      rekeyTo: Global.zeroAddress,
    }
    for (const bad of [
      { sender: ctx.any.account() },
      { receiver: ctx.any.account() },
      { closeRemainderTo: ctx.any.account() },
      { rekeyTo: ctx.any.account() },
      { amount: 1 },
    ]) {
      expect(() => example.test1(ctx.any.txn.payment({ ...costsPayment, ...bad }))).toThrow()
    }
    example.requestId.value = 7
    example.requester.value = new arc4.Address(requester)
    example.refund.value = 37_700
    const output = Bytes(new Uint8Array(32)) as Randomness
    ctx.ledger.patchGlobalData({ callerApplicationId: 0 })
    expect(() => example.fulfillRandomness(7, new arc4.Address(requester), output)).toThrow(/ERR:UnauthorizedCallback/)
    ctx.ledger.patchGlobalData({ callerApplicationId: beaconApp.id })
    expect(() => example.fulfillRandomness(8, new arc4.Address(requester), output)).toThrow(/ERR:UnknownRequest/)
    expect(() => example.fulfillRandomness(7, new arc4.Address(ctx.any.account()), output)).toThrow(
      /ERR:RequesterMismatch/,
    )
    example.fulfillRandomness(7, new arc4.Address(requester), output)
    expect(() => example.fulfillRandomness(7, new arc4.Address(requester), output)).toThrow(/ERR:UnknownRequest/)
    expect(BigInt(example.refund.value)).toBe(37_700n)
  })
})
