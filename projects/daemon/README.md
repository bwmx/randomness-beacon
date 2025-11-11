# Randomness Beacon

## Daemon

A worker that polls the beacon app at regular intervals, checks for pending randomness requests (in the apps created boxes) then dispatches relevant app calls depending on the state of the requests to manage the requests.

### Flow

1. Query all of the `RandomnessRequest` in the `requests` BoxMap of the `Beacon App`

2. If any of the requests are stale (too far behind the last block we can read on the AVM) call `cancelRequest(requestId)` of the `Beacon App` to cancel the request (refunding the requester fees and box cost) otherwise `completeRequest(requestId, proof)` is called with the vrf proof output which fulfills the randomness request.

## Deployment and Testing

### Environment Variables (Required)

| Name               | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| `LOG_LEVEL`        | The log severity level (optional! default: info)                  |
| `POLL_INTERVAL`    | How often should the daemon poll the `Beacon App` in milliseconds |
| `VRF_SECRET_KEY`   | Base64 string version of the vrf keypair secret key               |
| `BEACON_APP_ID`    | AppID of the `Beacon App`                                         |
| `MANAGER_MNEMONIC` | 25-word mnemonic of the manager                                   |
| `ALGOD_TOKEN`      | Algod token                                                       |
| `ALGOD_SERVER`     | Algod host                                                        |
| `ALGOD_PORT`       | Algod port                                                        |

### Local Testing

1. Installed required dependencies with `npm install`
2. Run `npm run link` to generate and link client
3. Run `cp .env.example .env` then configure the required environment variables
4. Start daemon in dev mode with `npm run dev`

### Production Deployment

You can easily deploy this app to cloud services, target NodeJS v22.X or higher and consider that this is a workspace project. There are no external dependencies apart from the NodeJS environment. Below are some generic instructions:

1. Configure the environment with all required environment variables (check `.env.example`)
2. Specify the working directory as `projects/daemon` (if required)
3. Run `npm run link` to generate and link client
4. Specify `npm run build` as the build command
5. Specify `npm run start` to start the daemon

## Utils

#### Generate VRF Keypair

Utility has been provided to generate a VRF keypair (private and public key) in base64 for convenience, you can use the output for your deployed applications. You can generate a keypair using the below command:

`npm run generate-keypair`

The output will look like this:

```
publicKey:
8EXyxG94NjiDwy4GLbsF7I8UkkoDLBl2ZLCA+EI7cq8=
secretKey:
005H6cwJDIH3H7pIRJsLfj58tQF2xbQYNXZU8t17rUTwRfLEb3g2OIPDLgYtuwXsjxSSSgMsGXZksID4Qjtyrw==
```

You should always keep the secret key private, do not share this publicly. The public key can be provided so users/apps can verify the generated VRF proofs if required.
