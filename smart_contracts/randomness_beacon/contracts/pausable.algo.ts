import { arc4, Contract, Global, GlobalState, loggedAssert, Txn } from '@algorandfoundation/algorand-typescript'

// ARC-65 error codes
const ERR_NOT_PAUSER = 'NotPauser'
const ERR_ZERO_ADDRESS = 'ZeroAddress'
const ERR_PAUSED = 'Paused'

export class Pausable extends Contract {
  private _pauser = GlobalState<arc4.Address>({
    key: 'pauser',
    initialValue: new arc4.Address(Global.creatorAddress),
  })

  // initially not paused
  paused = GlobalState<arc4.Bool>({ key: 'paused', initialValue: new arc4.Bool(false) })

  protected whenNotPaused(): void {
    loggedAssert(!this.paused.value.native, ERR_PAUSED)
  }

  protected onlyPauser(): void {
    loggedAssert(this._pauser.value.native === Txn.sender, ERR_NOT_PAUSER)
  }

  pause(): void {
    this.onlyPauser()

    this.paused.value = new arc4.Bool(true)

    // TODO: log pause event
  }

  unpause(): void {
    this.onlyPauser()

    this.paused.value = new arc4.Bool(false)
  }

  updatePauser(_newPauser: arc4.Address): void {
    this.onlyPauser()

    loggedAssert(_newPauser.native !== Global.zeroAddress, ERR_ZERO_ADDRESS)
    this._pauser.value = _newPauser

    // TODO: log update pauser event
  }

  /**
   * Convenience function to get the pauser
   * @returns The current pauser
   */
  @arc4.abimethod({ readonly: true })
  public pauser(): arc4.Address {
    return this._pauser.value
  }
}
