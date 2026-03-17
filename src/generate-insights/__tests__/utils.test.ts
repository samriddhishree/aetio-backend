import { describe, expect, it } from "vitest";
import { chunkArray, hashId, mapWithConcurrency } from "../services/utils";

describe("utils", () => {
  it("hashId is deterministic", () => {
    expect(hashId("abc")).toEqual(hashId("abc"));
    expect(hashId("abc")).not.toEqual(hashId("abcd"));
  });

  it("chunkArray splits arrays", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("mapWithConcurrency preserves order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 2, async (item) => item * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });
});
