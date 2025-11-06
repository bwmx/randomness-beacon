import {
  abimethod,
  Application,
  arc4,
  Contract,
  Global,
  GlobalState,
  gtxn,
  itxn,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { RandomnessBeacon } from '../contract.algo'
import { IRandomnessBeaconRequester, VrfOutput } from '../types.algo'

export class ExampleCaller extends Contract implements IRandomnessBeaconRequester {
  // beacon app
  beaconApp = GlobalState<Application>({ key: 'beaconApp' })
  // used to track
  totalFulfilled = GlobalState<uint64>({ key: 'totalFulfilled', initialValue: 0 })
  // to store last vrf output
  output = GlobalState<VrfOutput>({ key: 'output' })
  // store request ID
  requestId = GlobalState<uint64>({ key: 'requestId' })

  @abimethod({ onCreate: 'require' })
  createApplication(beaconApp: Application): void {
    this.beaconApp.value = beaconApp
  }

  public test1(costsPayment: gtxn.PaymentTxn): [uint64, uint64] {
    const feePayment = itxn.payment({
      receiver: this.beaconApp.value.address,
      amount: costsPayment.amount,
    })

    const targetRound: uint64 = Global.round + 1

    const r = arc4.abiCall<typeof RandomnessBeacon.prototype.createRequest>({
      appId: this.beaconApp.value,
      args: [new arc4.Address(Txn.sender), targetRound, feePayment],
    })

    return [r.returnValue, targetRound]
  }

  public fulfillRandomness(requestId: uint64, requesterAddress: arc4.Address, output: VrfOutput): void {
    this.output.value = output
    this.totalFulfilled.value += 1
  }
}
