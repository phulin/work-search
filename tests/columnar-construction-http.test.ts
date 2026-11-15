import { expect, it } from "vitest";
import { retryableConstructionError } from "../scripts/construction-http.js";

it("retries R2 throttling across operations and transport/busy failures without retrying invalid data", () => {
  for (const error of [
    undefined,
    "Busy",
    "Error: get: Reduce your rate of simultaneous reads on the same object. (10058)",
    "Error: put: Reduce your concurrent request rate for the same object. (10058)",
    "Error: head: Reduce your concurrent request rate for the same object. (10058)",
    "Error: delete: Reduce your concurrent request rate for the same object. (10058)",
    "Error: list: Reduce your concurrent request rate for the same object. (10058)",
  ])
    expect(retryableConstructionError(error)).toBe(true);
  for (const error of [
    "Checksum mismatch",
    "Generation changed",
    "Missing object",
    "Invalid record 10058",
    "Error: get: unknown failure (12345)",
    "Error: put: checksum mismatch",
    "Error: head: missing object",
  ])
    expect(retryableConstructionError(error)).toBe(false);
});
