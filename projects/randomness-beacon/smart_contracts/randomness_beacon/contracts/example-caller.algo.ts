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
} from '@algorandfoundation/algorand-typescript'
import { RandomnessBeacon } from '../contract.algo'
import { RandomnessBeaconCaller } from '../types.algo'

export class ExampleCaller extends Contract implements RandomnessBeaconCaller {
  // beacon app
  beaconApp = GlobalState<Application>({ key: 'beaconApp' })
  // used to track
  totalFulfilled = GlobalState<arc4.UintN64>({ key: 'totalFulfilled', initialValue: new arc4.UintN64(0) })
  // to store last vrf output
  output = GlobalState<arc4.StaticBytes<64>>({ key: 'output' })
  // store request ID
  requestId = GlobalState<arc4.UintN64>({ key: 'requestId' })

  @abimethod({ onCreate: 'require' })
  createApplication(beaconApp: Application): void {
    this.beaconApp.value = beaconApp
  }

  public test1(costsPayment: gtxn.PaymentTxn): arc4.Tuple<[arc4.UintN64, arc4.UintN64]> {
    const feePayment = itxn.payment({ receiver: this.beaconApp.value.address, amount: costsPayment.amount })

    const targetRound = new arc4.UintN64(Global.round + 1)
    const r = arc4.abiCall(RandomnessBeacon.prototype.createRequest, {
      appId: this.beaconApp.value,
      args: [new arc4.Address(Txn.sender), targetRound, feePayment],
    })

    return new arc4.Tuple(r.returnValue, targetRound)
  }
  public fulfillRandomness(
    requestId: arc4.UintN64,
    requesterAddress: arc4.Address,
    output: arc4.StaticBytes<64>,
  ): void {
    this.output.value = output
    this.totalFulfilled.value = new arc4.UintN64(this.totalFulfilled.value.native + 1)
  }
}
