import { describe, expect, it } from "vitest";
import { tidyBackupName } from "./backupnames";

/**
 * Backed-up photos used to be stored under their export path: the asset
 * id, sanitized, prefixed to the real filename for uniqueness on disk.
 * New uploads carry the library's own name now; this recovers it for the
 * ones already stored, and must never touch anything else.
 */
describe("tidyBackupName", () => {
  const id = "3F2A1B4C-5D6E-7F80-9A0B-1C2D3E4F5061/L0/001";
  const prefixed = "3F2A1B4C_5D6E_7F80_9A0B_1C2D3E4F5061_L0_001-IMG_0042.HEIC";

  it("recovers the camera name from an id-prefixed one", () => {
    expect(tidyBackupName(prefixed, id)).toBe("IMG_0042.HEIC");
  });

  it("keeps every character of the real name, dashes included", () => {
    expect(
      tidyBackupName("3F2A1B4C_5D6E_7F80_9A0B_1C2D3E4F5061_L0_001-my-trip-day-2.mov", id),
    ).toBe("my-trip-day-2.mov");
  });

  it("leaves a name alone that carries no prefix", () => {
    expect(tidyBackupName("IMG_0042.HEIC", id)).toBeNull();
  });

  it("leaves a name alone whose prefix belongs to a different asset", () => {
    expect(tidyBackupName(prefixed, "OTHER-ID/L0/001")).toBeNull();
  });

  it("refuses to rename a file into nothing", () => {
    expect(tidyBackupName("3F2A1B4C_5D6E_7F80_9A0B_1C2D3E4F5061_L0_001-", id)).toBeNull();
  });
});
