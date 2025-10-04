import VrfModule from "./vrf";

// this is a mess, but I couldn't get libsodium to compile correctly, so glued this together (thanks to grzracz for building it)

// maybe cleaner way to do this using import()
// import('./vrf').then((v) => {
//   // v == Module ref
//   console.log(v)
// })

let runTimeInitialized = false;

// wrapper over vrf funcs
const VRF = {
  _module: undefined as any,
  _constants: undefined as any,
  _loadModule: undefined as any,

  init: async function () {
    if (!this._loadModule) {
      this._loadModule = await new Promise((resolve) => {
        if (VrfModule.calledRun) {
          console.log("runtime already intialised");
          this._module = VrfModule;
          this._constants = {
            PUBLICKEYBYTES: this._module.ccall("vrf_publickeybytes", "number", [], []),
            SECRETKEYBYTES: this._module.ccall("vrf_secretkeybytes", "number", [], []),
            PROOFBYTES: this._module.ccall("vrf_proofbytes", "number", [], []),
            OUTPUTBYTES: this._module.ccall("vrf_outputbytes", "number", [], []),
          };
          this._module.getRandomValue = () => {
            const array = new Uint32Array(1);
            crypto.getRandomValues(array);
            return array[0];
          };
          resolve(true);
        } else {
          // wait for onRun callback
          VrfModule.onRuntimeInitialized = () => {
            runTimeInitialized = true;
            this._module = VrfModule;
            this._constants = {
              PUBLICKEYBYTES: this._module.ccall("vrf_publickeybytes", "number", [], []),
              SECRETKEYBYTES: this._module.ccall("vrf_secretkeybytes", "number", [], []),
              PROOFBYTES: this._module.ccall("vrf_proofbytes", "number", [], []),
              OUTPUTBYTES: this._module.ccall("vrf_outputbytes", "number", [], []),
            };
            this._module.getRandomValue = () => {
              const array = new Uint32Array(1);
              crypto.getRandomValues(array);
              return array[0];
            };
            resolve(true);
          };
        }
      });
    }
  },
  keypair() {
    const pkPtr = this._module._malloc(this._constants.PUBLICKEYBYTES);
    const skPtr = this._module._malloc(this._constants.SECRETKEYBYTES);

    const result = this._module.ccall("vrf_keypair", "number", ["number", "number"], [pkPtr, skPtr]);

    const pk = new Uint8Array(this._module.HEAPU8.buffer, pkPtr, this._constants.PUBLICKEYBYTES);
    const sk = new Uint8Array(this._module.HEAPU8.buffer, skPtr, this._constants.SECRETKEYBYTES);

    const pkCopy = new Uint8Array(pk);
    const skCopy = new Uint8Array(sk);

    this._module._free(pkPtr);
    this._module._free(skPtr);

    return { publicKey: pkCopy, secretKey: skCopy, result };
  },

  prove(sk: Uint8Array<ArrayBuffer>, message: any) {
    const proofPtr = this._module._malloc(this._constants.PROOFBYTES);
    const skPtr = this._module._malloc(this._constants.SECRETKEYBYTES);
    const messagePtr = this._module._malloc(message.length);

    this._module.HEAPU8.set(sk, skPtr);
    this._module.HEAPU8.set(message, messagePtr);

    const result = this._module.ccall(
      "vrf_prove",
      "number",
      ["number", "number", "number", "number"],
      [proofPtr, skPtr, messagePtr, message.length]
    );

    const proof = new Uint8Array(this._module.HEAPU8.buffer, proofPtr, this._constants.PROOFBYTES);
    const proofCopy = new Uint8Array(proof);

    this._module._free(proofPtr);
    this._module._free(skPtr);
    this._module._free(messagePtr);

    return { proof: proofCopy, result };
  },

  verify(pk: any, proof: any, message: any) {
    const outputPtr = this._module._malloc(this._constants.OUTPUTBYTES);
    const pkPtr = this._module._malloc(this._constants.PUBLICKEYBYTES);
    const proofPtr = this._module._malloc(this._constants.PROOFBYTES);
    const messagePtr = this._module._malloc(message.length);

    this._module.HEAPU8.set(pk, pkPtr);
    this._module.HEAPU8.set(proof, proofPtr);
    this._module.HEAPU8.set(message, messagePtr);

    const result = this._module.ccall(
      "vrf_verify",
      "number",
      ["number", "number", "number", "number", "number"],
      [outputPtr, pkPtr, proofPtr, messagePtr, message.length]
    );

    const output = new Uint8Array(this._module.HEAPU8.buffer, outputPtr, this._constants.OUTPUTBYTES);
    const outputCopy = new Uint8Array(output);

    this._module._free(outputPtr);
    this._module._free(pkPtr);
    this._module._free(proofPtr);
    this._module._free(messagePtr);

    return { output: outputCopy, result };
  },

  proofToHash(proof: any) {
    const hashPtr = this._module._malloc(this._constants.OUTPUTBYTES);
    const proofPtr = this._module._malloc(this._constants.PROOFBYTES);

    this._module.HEAPU8.set(proof, proofPtr);

    const result = this._module.ccall("vrf_proof_to_hash", "number", ["number", "number"], [hashPtr, proofPtr]);

    const hash = new Uint8Array(this._module.HEAPU8.buffer, hashPtr, this._constants.OUTPUTBYTES);
    const hashCopy = new Uint8Array(hash);

    this._module._free(hashPtr);
    this._module._free(proofPtr);

    return { hash: hashCopy, result };
  },
};

export default VRF;
