import { bytesToBase64 } from 'algosdk'
import { generateKeyPair, init } from '@bwmx/algorand-vrf-utils-ts'

// Prints a fresh VRF keypair as env lines: the public key goes to the beacon deploy, the secret key to the daemon.
init().then(() => {
  const { publicKey, secretKey } = generateKeyPair()
  console.log(`# beacon deploy (public)\nVRF_KEYPAIR_PUBLIC_KEY=${bytesToBase64(publicKey)}`)
  console.log(`# daemon (secret: store it like a private key and back it up; the beacon cannot be re-keyed)`)
  console.log(`VRF_PRIVATE_KEY=${bytesToBase64(secretKey)}`)
})
