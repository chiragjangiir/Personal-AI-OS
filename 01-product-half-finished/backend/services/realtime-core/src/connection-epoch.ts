import {
  assertDecimalConnectionEpoch,
  compareDecimalConnectionEpoch,
  incrementDecimalConnectionEpoch,
  type DecimalConnectionEpoch,
} from "./types.ts";

export { assertDecimalConnectionEpoch, compareDecimalConnectionEpoch, incrementDecimalConnectionEpoch };
export type { DecimalConnectionEpoch };

export function assertEpochMatches(
  expected: DecimalConnectionEpoch,
  actual: DecimalConnectionEpoch,
): DecimalConnectionEpoch {
  if (compareDecimalConnectionEpoch(expected, actual) !== 0) {
    throw new Error("CONNECTION_EPOCH_CONFLICT");
  }
  return actual;
}

export function assertEpochAdvanced(
  previous: DecimalConnectionEpoch,
  next: DecimalConnectionEpoch,
): DecimalConnectionEpoch {
  if (compareDecimalConnectionEpoch(previous, next) >= 0) {
    throw new Error("CONNECTION_EPOCH_NOT_ADVANCED");
  }
  return next;
}

export function nextConnectionEpoch(
  previous: DecimalConnectionEpoch,
): DecimalConnectionEpoch {
  return incrementDecimalConnectionEpoch(assertDecimalConnectionEpoch(previous));
}

