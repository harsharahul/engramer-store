import type { KeyAttributes } from "@engramer/crypto";

/** A credential route was handed a change it is not allowed to make. */
export class ForbiddenKeyChange extends Error {
  constructor(field: string) {
    super(`the ${field} key attribute cannot be changed by this request`);
    this.name = "ForbiddenKeyChange";
  }
}

/**
 * Merges a credential change into the stored key attributes, field by
 * named field. A password change may rewrap the master key and nothing
 * else; a recovery-key rotation may reseal the recovery pair and nothing
 * else. Anything outside the allowlist is refused rather than ignored, so
 * a route can never quietly become a way to replace an account's identity
 * keys. Clients echo the whole object back, so a disallowed field that is
 * byte-identical to what is stored passes.
 */
export function mergeKeyAttributes(
  stored: KeyAttributes,
  submitted: KeyAttributes,
  allowed: ReadonlyArray<keyof KeyAttributes>,
): KeyAttributes {
  const merged: KeyAttributes = { ...stored };
  for (const field of Object.keys(stored) as Array<keyof KeyAttributes>) {
    if (allowed.includes(field)) {
      merged[field] = submitted[field] as never;
      continue;
    }
    if (JSON.stringify(submitted[field]) !== JSON.stringify(stored[field])) {
      throw new ForbiddenKeyChange(field);
    }
  }
  return merged;
}
