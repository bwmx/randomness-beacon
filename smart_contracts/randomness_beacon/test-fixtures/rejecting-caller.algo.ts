import { arc4, GlobalState, loggedAssert, uint64 } from '@algorandfoundation/algorand-typescript'
import { ExampleCaller } from '../contracts/example-caller.algo'
import { Randomness } from '../types.algo'

/** LocalNet fixture only: exercises callback rollback and recovery. Never deploy as a real requester. */
export class RejectingCaller extends ExampleCaller {
  private rejectCallback = GlobalState<boolean>({ key: 'rejectCallback', initialValue: true })

  public setRejectCallback(reject: boolean): void {
    this.rejectCallback.value = reject
  }

  public override fulfillRandomness(requestId: uint64, requesterAddress: arc4.Address, output: Randomness): void {
    super.fulfillRandomness(requestId, requesterAddress, output)
    loggedAssert(!this.rejectCallback.value, 'TestCallbackRejected')
  }
}
