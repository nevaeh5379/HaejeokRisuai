// Adapted from Comfy-Org/ComfyUI_frontend, revision 6b0f2bd013fa16c33932085ba519cf8967b03fa7.
// Upstream source: LiteGraph.isValidConnection excerpt
import type { SlotType } from "./types";
export const LiteGraph = {
  EVENT: -1,
  ACTION: -1,
  isValidConnection(type_a: SlotType, type_b: SlotType): boolean {
    if (type_a == "" || type_a === "*") type_a = 0;
    if (type_b == "" || type_b === "*") type_b = 0;
    // If generic in/output, matching types (valid for triggers), or event/action types
    if (
      !type_a ||
      !type_b ||
      type_a == type_b ||
      (type_a == this.EVENT && type_b == this.ACTION)
    ) {
      return true;
    }

    // Enforce string type to handle toLowerCase call (-1 number not ok)
    type_a = String(type_a);
    type_b = String(type_b);
    type_a = type_a.toLowerCase();
    type_b = type_b.toLowerCase();

    // For nodes supporting multiple connection types
    if (!type_a.includes(",") && !type_b.includes(",")) return type_a == type_b;

    // Check all permutations to see if one is valid
    const supported_types_a = type_a.split(",");
    const supported_types_b = type_b.split(",");
    for (const a of supported_types_a) {
      for (const b of supported_types_b) {
        if (this.isValidConnection(a, b)) return true;
      }
    }

    return false;
  },
};
