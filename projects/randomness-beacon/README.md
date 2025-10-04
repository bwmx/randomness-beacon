# Randomness Beacon

## Smart Contracts

### Terms

Beacon App = the deployed beacon app
Requester = the requester of the randomness
Requester App = the app id from where the request originated
Caller = the account calling cancelRequest() or completeRequest()

### Flow

1. `Requester App` calls `createRequest(requesterAddress, round, feePayment)` with who the `Requester` is and the desired future round of which the block seed will be used to generate randomness.

2. `Caller` (usually the Daemon or another account with access to the vrf keypair and can generate proofs) calls `completeRequest(requestId, proof)` where requestId = ID of the request and proof = 80 byte vrf proof output

3. Beacon App verifies the proof, then calls `fulfillRandomness(requestId, requesterAddress, output)` method of the `Requester App`. Caller then receives a payment of `request.feePaid` from the `Beacon App` to cover their txn costs, the request (box) is deleted and the `Requester` receives a refund of `request.boxCost` (the cost of storing the request in a box).

## Usage from other smart contracts

The `Beacon App` is designed to only allow other smart contracts to create requests. These contracts must implement the `FulfillRandomnessFunction` of the `RandomnessBeaconCaller` to receive randomness. The puya-ts implementation can be seen below:

```
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
```

An example caller could be used like this:

```
export class ExampleCaller extends Contract implements RandomnessBeaconCaller {
  // beacon app
  beaconApp = GlobalState<Application>({ key: 'beaconApp' })
  // used to track
  totalFulfilled = GlobalState<arc4.UintN64>({ key: 'totalFulfilled', initialValue: new arc4.UintN64(0) })
  // to store last vrf output
  output = GlobalState<arc4.StaticBytes<64>>({ key: 'output' })

  @abimethod({ onCreate: 'require' })
  createApplication(beaconApp: Application): void {
    this.beaconApp.value = beaconApp
  }

  public testCreateRequest(costsPayment: gtxn.PaymentTxn): arc4.Tuple<[arc4.UintN64, arc4.UintN64]> {
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
```

Requesting applications should call `createRequest(requesterAddress, round, costsPayment)`. `costsPayment` must be >= the total cost required to create and fulfill a request. This can be retrieved by simulating the `getCosts()` readonly method of the `Beacon App`, a payment covering the costs can then be constructed ahead of time.

### Additional fees

If the `fulfillRandomness` callback of the `Requester App` has higher txn fees than returned by the `getCosts()` method the caller can simply add additional amounts in multiplies of the min txn fee (currently 0.001 but may change in future). These additional fees will be used to pay the `Caller` of the `completeRequest()` method.
