/**
 * Validity window (rounds) for submitProof. The AVM `block` opcode only reads rounds r with
 * LastValid - 1002 < r < FirstValid. With FirstValid = last committed round + 1, a round is provable as soon as it
 * is committed and, with a short window, for MAX_SEED_AGE rounds; algokit's localnet default (1000) would not be.
 */
export const PROOF_VALIDITY_WINDOW = 10n
export const MAX_SEED_AGE = 1001n - PROOF_VALIDITY_WINDOW

/** Transactions per group (protocol limit); a proof's group carries up to 15 of its round's fulfillments. */
export const MAX_GROUP_SIZE = 16

/**
 * Whether the seed of `round` can be proven now, given the last committed round: from the moment the round is
 * committed (age 0) until it leaves the AVM's readable window. Cancellation eligibility does not prevent it.
 */
export function canProve(round: bigint, lastRound: bigint): boolean {
  const age = lastRound - round
  return age >= 0n && age < MAX_SEED_AGE
}

/** Rounds to wait before retrying a request after `failures` consecutive failures: 2, 4, 8 … capped at 64. */
export function retryDelay(failures: number): bigint {
  return BigInt(Math.min(2 ** failures, 64))
}

/**
 * Past rounds whose proof status must be read from their boxes. A round at or after `lastRound` cannot be proven
 * yet (a proof lands in a later block), a proven round stays proven until its box is deleted, and an unproven one
 * only changes when the beacon's `totalProofs` counter does.
 */
export function roundsToCheck(
  rounds: Iterable<bigint>,
  lastRound: bigint,
  proven: Set<bigint>,
  checkedAt: Map<bigint, bigint>,
  totalProofs: bigint,
): bigint[] {
  return [...rounds].filter((round) => round < lastRound && !proven.has(round) && checkedAt.get(round) !== totalProofs)
}

/** Splits `items` into consecutive groups of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
}
