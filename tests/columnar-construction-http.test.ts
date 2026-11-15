import { expect, it } from "vitest";
import { retryableConstructionError } from "../scripts/construction-http.js";

it("retries R2 read throttling and transport/busy failures without retrying invalid data", () => {
  for (const error of [
    undefined,
    "Busy",
    "Error: get: Reduce your rate of simultaneous reads on the same object. (10058)",
  ])
    expect(retryableConstructionError(error)).toBe(true);
  for (const error of [
    "Checksum mismatch",
    "Generation changed",
    "Missing object",
    "Invalid record 10058",
    "Error: get: unknown failure (12345)",
  ])
    expect(retryableConstructionError(error)).toBe(false);
});
