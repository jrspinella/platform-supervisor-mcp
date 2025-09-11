import { describe, it, expect } from "vitest";
import { deepMerge } from "../src/loaders.js";

describe("deepMerge", () => {
  it("merges nested objects", () => {
    const a = { a: 1, o: { x: 1, y: 2 } };
    const b = { b: 2, o: { y: 9, z: 3 } };
    expect(deepMerge(a, b)).toEqual({ a: 1, b: 2, o: { x: 1, y: 9, z: 3 } });
  });

  it("overrides arrays from b", () => {
    const a = { list: [1, 2], o: { arr: ["a"] } } as any;
    const b = { list: [3], o: { arr: ["b"] } } as any;
    expect(deepMerge(a, b)).toEqual({ list: [3], o: { arr: ["b"] } });
  });

  it("prefers b when scalar", () => {
    expect(deepMerge(1 as any, 2 as any)).toBe(2);
  });

  it("falls back to a when b is null/undefined", () => {
    expect(deepMerge({ a: 1 } as any, undefined as any)).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 } as any, null as any)).toEqual({ a: 1 });
  });
});
