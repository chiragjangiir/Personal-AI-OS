import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDecimalConnectionEpoch,
  compareDecimalConnectionEpoch,
  incrementDecimalConnectionEpoch,
} from "../src/types.ts";

test("connection epochs remain decimal strings and increment without Number", () => {
  const large = assertDecimalConnectionEpoch("9999999999999999999999999999999999999");
  assert.equal(typeof large, "string");
  assert.equal(incrementDecimalConnectionEpoch(assertDecimalConnectionEpoch("1")), "2");
  assert.equal(
    incrementDecimalConnectionEpoch(large),
    "10000000000000000000000000000000000000",
  );
  assert.equal(compareDecimalConnectionEpoch(assertDecimalConnectionEpoch("9"), assertDecimalConnectionEpoch("10")), -1);
  assert.throws(() => assertDecimalConnectionEpoch("01"), /INVALID_CONNECTION_EPOCH/);
  assert.throws(() => assertDecimalConnectionEpoch("0"), /INVALID_CONNECTION_EPOCH/);
  assert.throws(() => assertDecimalConnectionEpoch(1), /INVALID_CONNECTION_EPOCH/);
});
