import { arc4, assert, Contract, Global, GlobalState, Txn } from '@algorandfoundation/algorand-typescript'

const ERR_ONLY_PAUSER = 'only pauser can call this method'
const ERR_ZERO_ADDRESS = 'pauser cannot be zero address'

export class Pausable extends Contract {
  private _pauser = GlobalState<arc4.Address>({
    key: 'pauser',
    initialValue: new arc4.Address(Global.creatorAddress),
  })

  // initially not paused
  paused = GlobalState<arc4.Bool>({ key: 'paused', initialValue: new arc4.Bool(false) })

  protected whenNotPaused(): void {
    assert(!this.paused.value.native)
  }

  protected onlyPauser(): void {
    assert(this._pauser.value.native === Txn.sender, ERR_ONLY_PAUSER)
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

    assert(_newPauser.native !== Global.zeroAddress, ERR_ZERO_ADDRESS)
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
