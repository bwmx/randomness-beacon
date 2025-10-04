import { bytesToBase64 } from 'algosdk'
import libvrf from '../../libvrf/index'

// bare minimum to get a base64 output of the vrf keypair
libvrf.init().then(() => {
  const { publicKey, secretKey, result } = libvrf.keypair()

  if (result === 0) {
    console.log(`publicKey:\n${bytesToBase64(publicKey)}`)
    console.log(`secretKey:\n${bytesToBase64(secretKey)}`)
  }
})
