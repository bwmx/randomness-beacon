import {
  abimethod,
  Account,
  Application,
  arc4,
  Contract,
  Global,
  GlobalState,
  gtxn,
  itxn,
  loggedAssert,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { RandomnessBeacon } from '../contract.algo'
import { IRandomnessBeaconRequester, Randomness } from '../types.algo'

export class ExampleCaller extends Contract implements IRandomnessBeaconRequester {
  beaconApp = GlobalState<Application>({ key: 'beaconApp' })
  totalFulfilled = GlobalState<uint64>({ key: 'totalFulfilled', initialValue: 0 })
  output = GlobalState<Randomness>({ key: 'output' })
  requestId = GlobalState<uint64>({ key: 'requestId', initialValue: 0 })
  requester = GlobalState<arc4.Address>({ key: 'requester' })
  refund = GlobalState<uint64>({ key: 'refund', initialValue: 0 })

  @abimethod({ onCreate: 'require' })
  createApplication(beaconApp: Application): void {
    this.beaconApp.value = beaconApp
  }

  public test1(costsPayment: gtxn.PaymentTxn): [uint64, uint64] {
    // ponytail: one request/claim at a time; use funded boxes for a concurrent requester app.
    loggedAssert(this.requestId.value === 0 && this.refund.value === 0, 'PreviousRequestUnclaimed')
    loggedAssert(
      costsPayment.sender === Txn.sender &&
        costsPayment.receiver === Global.currentApplicationAddress &&
        costsPayment.closeRemainderTo === Global.zeroAddress &&
        costsPayment.rekeyTo === Global.zeroAddress,
      'InvalidPayment',
    )
    const costs = arc4.abiCall<typeof RandomnessBeacon.prototype.getCosts>({
      appId: this.beaconApp.value,
      args: [],
      fee: 0,
    }).returnValue
    loggedAssert(costsPayment.amount >= costs.fees + costs.boxMbr, 'InsufficientFunding')
    const feePayment = itxn.payment({
      receiver: this.beaconApp.value.address,
      amount: costsPayment.amount,
      fee: 0,
    })
    const targetRound: uint64 = Global.round + 1
    const request = arc4.abiCall<typeof RandomnessBeacon.prototype.createRequest>({
      appId: this.beaconApp.value,
      args: [new arc4.Address(Txn.sender), targetRound, feePayment],
      fee: 0,
    })
    this.requestId.value = request.returnValue
    this.requester.value = new arc4.Address(Txn.sender)
    this.refund.value = costs.boxMbr
    return [request.returnValue, targetRound]
  }

  public fulfillRandomness(requestId: uint64, requesterAddress: arc4.Address, output: Randomness): void {
    loggedAssert(Global.callerApplicationId === this.beaconApp.value.id, 'UnauthorizedCallback')
    loggedAssert(this.requestId.value !== 0 && requestId === this.requestId.value, 'UnknownRequest')
    loggedAssert(requesterAddress.native === this.requester.value.native, 'RequesterMismatch')
    this.output.value = output
    this.totalFulfilled.value += 1
    this.requestId.value = 0
  }

  /** Anyone may trigger expiry, but only this app can cancel its beacon request. */
  public expireRequest(): void {
    loggedAssert(this.requestId.value !== 0, 'NoPendingRequest')
    this.refund.value = arc4.abiCall<typeof RandomnessBeacon.prototype.cancelRequest>({
      appId: this.beaconApp.value,
      args: [this.requestId.value],
      fee: 0,
    }).returnValue
    this.requestId.value = 0
  }

  public claim(receiver: Account): void {
    loggedAssert(Txn.sender === this.requester.value.native, 'NotRequester')
    loggedAssert(this.requestId.value === 0 && this.refund.value > 0, 'NoSettledRefund')
    const amount = this.refund.value
    this.refund.value = 0
    itxn.payment({ receiver, amount, fee: 0 }).submit()
  }
}
