import { algos, Config, microAlgos } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Address } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { ExampleCallerFactory } from '../artifacts/randomness_beacon//contracts/ExampleCallerClient'
import { RandomnessBeaconFactory } from '../artifacts/randomness_beacon/RandomnessBeaconClient'

import libvrf from '../../../libvrf'

import { MAX_PENDING_REQUESTS, MAX_PENDING_TIME } from './types.algo'

describe('RandomnessBeacon contract', () => {
  const localnet = algorandFixture()

  beforeAll(async () => {
    await libvrf.init()
  })

  beforeAll(() => {
    Config.configure({
      debug: true,
      // traceAll: true,
    })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)

  // deploy dummy caller app that implements the callback
  const deployExampleCaller = async (account: Address, beaconAppId: bigint) => {
    const factory = localnet.algorand.client.getTypedAppFactory(ExampleCallerFactory, {
      defaultSender: account,
    })

    const { appClient } = await factory.deploy({
      onUpdate: 'append',
      onSchemaBreak: 'append',
      createParams: { args: [beaconAppId], method: 'createApplication' },
    })

    // this does not work
    await localnet.algorand.send.payment({
      sender: account,
      receiver: appClient.appAddress,
      amount: algos(0.1),
    })

    return { client: appClient }
  }

  const deploy = async (account: Address) => {
    const factory = localnet.algorand.client.getTypedAppFactory(RandomnessBeaconFactory, {
      defaultSender: account,
    })

    // generate vrf keypair
    const { publicKey, secretKey } = libvrf.keypair()

    const { appClient } = await factory.deploy({
      onUpdate: 'append',
      onSchemaBreak: 'append',
      createParams: { args: [publicKey], method: 'createApplication' },
    })

    // this does not work
    await localnet.algorand.send.payment({
      sender: account,
      receiver: appClient.appAddress,
      amount: algos(0.1),
    })

    appClient.state.box.requests.getMap()
    return { client: appClient, publicKey, secretKey }
  }

  test('initial global state correct', async () => {
    const { testAccount } = localnet.context
    const { client, publicKey } = await deploy(testAccount)

    const globalState = await client.state.global.getAll()

    // expect global state to match what we set
    expect(globalState).toMatchObject({
      publicKey: publicKey,
      currentRequestId: 1n,
      totalPendingRequests: 0n,
    })
  })

  test('can call createRequest()', async () => {
    const { testAccount } = localnet.context
    const { client, publicKey } = await deploy(testAccount)

    const globalState = await client.state.global.getAll()

    // expect global state to match what we set
    expect(globalState).toMatchObject({
      publicKey: publicKey,
      currentRequestId: 1n,
      totalPendingRequests: 0n,
    })

    const { client: exampleCallerApp } = await deployExampleCaller(testAccount, client.appId)

    // TODO: build paymentxn to cover the fees
    const [txnFees, boxCost] = await client.getCosts()
    const payment = localnet.context.algorand.createTransaction.payment({
      sender: testAccount,
      receiver: exampleCallerApp.appAddress,
      amount: microAlgos(txnFees + boxCost),
    })

    const r = await exampleCallerApp.send.test1({
      args: { costsPayment: payment },
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: algos(0.003), // should be enough for basic randomness request
    })

    // TODO: check box exists on the beacon app
    console.log('createRequest() = ', r.return)
  })

  test(
    'can call createRequest() many times',
    async () => {
      const { testAccount, algorand, generateAccount } = localnet.context
      const { client } = await deploy(testAccount)

      const { client: exampleCallerApp } = await deployExampleCaller(testAccount, client.appId)

      // fill entirely
      const amount = MAX_PENDING_REQUESTS

      for (let i = 0; i < amount; i++) {
        const acc = await generateAccount({ initialFunds: (1).algos() })

        // TODO: build paymentxn to cover the fees
        const [txnFees, boxCost] = await client.getCosts()
        const payment = algorand.createTransaction.payment({
          sender: acc,
          receiver: exampleCallerApp.appAddress,
          amount: microAlgos(txnFees + boxCost),
        })

        const r = await exampleCallerApp.send.test1({
          sender: acc,
          args: { costsPayment: payment },
          populateAppCallResources: true,
          coverAppCallInnerTransactionFees: true,
          maxFee: algos(0.003), // should be enough for basic randomness request
          maxRoundsToWaitForConfirmation: 1,
        })

        console.log('createRequest() = ', r.return)
      }
    },
    { timeout: 600000000 },
  )

  test('can call cancelRequest()', async () => {
    const { testAccount, algod, algorand } = localnet.context
    const { client, publicKey } = await deploy(testAccount)

    console.table(client.appClient.getGlobalState())

    const globalState = await client.state.global.getAll()

    // expect global state to match what we set
    expect(globalState).toMatchObject({
      publicKey: publicKey,
      currentRequestId: 1n,
      totalPendingRequests: 0n,
    })

    const { client: exampleCallerApp } = await deployExampleCaller(testAccount, client.appId)

    // get fees from readonly func on app
    const [txnFees, boxCost] = await client.getCosts()
    // create payment txn
    const payment = localnet.context.algorand.createTransaction.payment({
      sender: testAccount,
      receiver: exampleCallerApp.appAddress,
      amount: microAlgos(txnFees + boxCost),
    })

    const r = await exampleCallerApp.send.test1({
      args: { costsPayment: payment },
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: algos(0.003), // should be enough for basic randomness request
    })

    console.log('createRequest() = ', r.return)

    // we want to cancel, timeout is 1000 blocks (hardcoded)
    const timeoutRound = r.return![1] + BigInt(MAX_PENDING_TIME)

    // submit dummy txns to advance the rounds
    let status = await algod.status().do()
    while (status.lastRound <= timeoutRound) {
      await algorand.send.payment({
        sender: testAccount.addr,
        receiver: testAccount.addr,
        amount: algos(0),
        suppressLog: true, // no need to log these
      })
      status = await algod.status().do()
    }
    // wait for confirmedRound
    await algorand.client.algod.statusAfterBlock(timeoutRound).do()

    // call the smart contract, cancelling the request
    await client.send.cancelRequest({
      args: { requestId: r.return![0] },
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: algos(0.003),
    })
  })

  test('can call completeRequest()', async () => {
    const { testAccount, algod, algorand } = localnet.context
    const { client, publicKey, secretKey } = await deploy(testAccount)

    console.table(client.appClient.getGlobalState())

    const globalState = await client.state.global.getAll()

    // expect global state to match what we set
    expect(globalState).toMatchObject({
      publicKey: publicKey,
      currentRequestId: 1n,
      totalPendingRequests: 0n,
    })

    const { client: exampleCallerApp } = await deployExampleCaller(testAccount, client.appId)

    const exampleRequester = await localnet.context.generateAccount({ initialFunds: (10).algos() })

    const [txnFees, boxCost] = await client.getCosts()
    const payment = algorand.createTransaction.payment({
      sender: exampleRequester.addr,
      receiver: exampleCallerApp.appAddress,
      amount: microAlgos(txnFees + boxCost),
    })

    const r = await exampleCallerApp.send.test1({
      sender: exampleRequester,
      args: { costsPayment: payment },
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: algos(0.003), // should be enough for basic randomness request
    })

    console.log('createRequest() requestId and round', r.return)

    // submit dummy txns to advance the rounds
    let status = await algod.status().do()
    while (status.lastRound <= r.return![1]) {
      await algorand.send.payment({
        sender: testAccount.addr,
        receiver: testAccount.addr,
        amount: algos(0),
        suppressLog: true, // no need to log these
      })
      status = await algod.status().do()
    }
    // wait for confirmedRound
    await algod.statusAfterBlock(r.return![1]).do()
    // get block from node
    const { block } = await algod.block(r.return![1]).do()
    // get the seed from the header
    const { seed: blockSeed } = block.header
    // generate a vrf proof for this block seed using the secret key
    const { proof } = libvrf.prove(secretKey, blockSeed)

    // call the smart contract, submitting the vrf proof
    await client.send.completeRequest({
      args: { requestId: r.return![0], proof: proof },
      populateAppCallResources: true,
      appReferences: [client.appId],
      coverAppCallInnerTransactionFees: true,
      maxFee: algos(0.012),
    })

    // get global state of the example caller to see if the global state updated
    const totalFulfilled = await exampleCallerApp.state.global.totalFulfilled()

    // should have expected to received the callback once
    expect(totalFulfilled).toEqual(1n)
  })

  test(
    'can call completeRequests() many times',
    async () => {
      const { testAccount, algorand, generateAccount, algod } = localnet.context
      const { client, secretKey } = await deploy(testAccount)

      const { client: exampleCallerApp } = await deployExampleCaller(testAccount, client.appId)

      // just do the absolute limit
      const amount = MAX_PENDING_REQUESTS

      for (let i = 1; i <= amount; i++) {
        const acc = await generateAccount({ initialFunds: (1).algos() })

        // TODO: build paymentxn to cover the fees
        const [txnFees, boxCost] = await client.getCosts()
        const payment = algorand.createTransaction.payment({
          sender: acc,
          receiver: exampleCallerApp.appAddress,
          amount: microAlgos(txnFees + boxCost),
        })

        const r = await exampleCallerApp.send.test1({
          sender: acc,
          args: { costsPayment: payment },
          populateAppCallResources: true,
          coverAppCallInnerTransactionFees: true,
          maxFee: algos(0.003), // should be enough for basic randomness request
          maxRoundsToWaitForConfirmation: 1,
        })

        console.log('createRequest() = ', r.return)

        // submit dummy txns to advance the rounds
        let status = await algod.status().do()
        while (status.lastRound <= r.return![1]) {
          await algorand.send.payment({
            sender: testAccount.addr,
            receiver: testAccount.addr,
            amount: algos(0),
            suppressLog: true, // no need to log these
          })
          status = await algod.status().do()
        }
        // wait for confirmedRound
        await algod.statusAfterBlock(r.return![1]).do()
        // get block from node
        const { block } = await algod.block(r.return![1]).do()
        // get the seed from the header
        const { seed: blockSeed } = block.header
        // generate a vrf proof for this block seed using the secret key
        const { proof } = libvrf.prove(secretKey, blockSeed)

        // call the smart contract, submitting the vrf proof
        await client.send.completeRequest({
          args: { requestId: r.return![0], proof: proof },
          populateAppCallResources: true,
          appReferences: [client.appId],
          coverAppCallInnerTransactionFees: true,
          maxFee: algos(0.012),
        })
      }

      // get global state of the example caller to see if the global state updated
      const totalFulfilled = await exampleCallerApp.state.global.totalFulfilled()

      // should have expected to received the callback `i` number of times
      expect(totalFulfilled).toEqual(BigInt(amount))
    },
    { timeout: 600000000 },
  )
})
