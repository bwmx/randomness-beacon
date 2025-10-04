import { arc4, assert, Contract, Global, GlobalState, Txn } from '@algorandfoundation/algorand-typescript'

const ERR_ONLY_MANAGER = 'only manager can perform this action'
const ERR_ZERO_ADDRESS = 'manager cannot be zero address'

// TODO: log arc-28 events for various actions so management state can be viewed on chain easily
/**
 * Manageable contract, designed to be inherited by other contracts (address will always be set to app creator initially)
 * @remarks This contract is designed to be inherited by other contracts that need a manager.
 * The manager is the only one who can call certain methods, such as updating the manager address.
 * The manager is set to the creator of the contract by default.
 */
export class Managable extends Contract {
  private _manager = GlobalState<arc4.Address>({
    key: 'manager',
    initialValue: new arc4.Address(Global.creatorAddress),
  })

  /**
   * Only the manager can call this method
   * @remarks This method is used to ensure that only the manager perform certain actions in parent contracts
   */
  protected onlyManager(): void {
    assert(this._manager.value.native === Txn.sender, ERR_ONLY_MANAGER)
  }

  /**
   * Update the manager of this contract
   * @param manager The new manager address in arc4 format
   */
  public updateManager(newManager: arc4.Address): void {
    // only the current manager can set a new manager
    this.onlyManager()
    // ensure the new manager is not the zero address
    assert(newManager.native !== Global.zeroAddress, ERR_ZERO_ADDRESS)
    // blindly update the value
    this._manager.value = newManager
  }

  /**
   * Delete the manager of this contract
   * @remarks This delete's the manager of this contract, disabling all functions that require a manager DANGER!
   */
  public deleteManager(): void {
    // only the current manager can delete the manager
    this.onlyManager()
    // set the manager to the zero address
    this._manager.value = new arc4.Address(Global.zeroAddress)
  }

  /**
   * Convenience function to get the current manager of this contract
   * @returns The current manager of this contract
   */
  @arc4.abimethod({ readonly: true })
  public manager(): arc4.Address {
    return this._manager.value
  }
}
