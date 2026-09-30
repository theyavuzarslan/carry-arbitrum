/** JSON with bigint as decimal strings and Infinity as null-safe string. */
export const toJson = (v: unknown, space?: number): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x === Infinity ? "Infinity" : x), space);
