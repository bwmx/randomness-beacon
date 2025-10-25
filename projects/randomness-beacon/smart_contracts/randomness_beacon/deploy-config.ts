import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { RandomnessBeaconFactory } from '../artifacts/randomness_beacon/RandomnessBeaconClient'

// Below is a showcase of various deployment options you can use in TypeScript Client
export async function deploy() {
  console.log('=== Deploying RandomnessBeacon ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(RandomnessBeaconFactory, {
    defaultSender: deployer.addr,
  })
  // use base64 public key from env
  const publicKey = Buffer.from(process.env.VRF_KEYPAIR_PUBLIC_KEY!, 'base64')

  console.log(publicKey)
  const { appClient, result } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
    createParams: {
      args: { publicKey: publicKey, maxPendingRequests: 5n, maxFutureRounds: 100n, staleRequestTimeout: 1000n },
      method: 'createApplication(byte[32],uint64,uint64,uint64)void',
    },
  })

  // If app was just created fund the app account
  if (['create', 'replace'].includes(result.operationPerformed)) {
    await algorand.send.payment({
      amount: (1).algo(),
      sender: deployer.addr,
      receiver: appClient.appAddress,
    })
  }
}
