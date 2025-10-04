# Randomness Beacon

## Daemon

A worker that polls the beacon app at regular intervals, checks for pending randomness requests (in the apps created boxes) then dispatches relevant app calls depending on the state of the requests to manage the requests.

### Flow

1. Query all of the `RandomnessRequest` in the `requests` BoxMap of the `Beacon App`

2. If any of the requests are stale (too far behind the last block we can read on the AVM) call `cancelRequest(requestId)` of the `Beacon App` to cancel the request (refunding the requester fees and box cost) otherwise `completeRequest(requestId, proof)` is called with the vrf proof output which fulfills the randomness request.

## Deployment and Testing

### Environment Variables (Required)

| Name               | Value                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| `BEACON_APP_ID`    | AppID of the `Beacon App`                                              |
| `MANAGER_MNEMONIC` | 25-word mnemonic of the manager (default: creator of the `Beacon App`) |
| `ALGOD_TOKEN`      | Algod token                                                            |
| `ALGOD_SERVER`     | Algod host                                                             |
| `ALGOD_PORT`       | Algod port                                                             |

1. Installed required dependencies with `npm install`
2. Start daemon with `npm run start`
