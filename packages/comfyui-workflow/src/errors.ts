// Adapted from Comfy-Org/ComfyUI_frontend, revision 6b0f2bd013fa16c33932085ba519cf8967b03fa7.
// Upstream source: src/lib/litegraph/src/infrastructure/{InvalidLinkError,NullGraphError,RecursionError,SlotIndexError}.ts
export class InvalidLinkError extends Error {
  constructor(
    message: string = "Attempted to access a link that was invalid.",
    cause?: Error,
  ) {
    super(message, { cause });
    this.name = "InvalidLinkError";
  }
}

export class NullGraphError extends Error {
  constructor(
    message: string = "Attempted to access LGraph reference that was null or undefined.",
    cause?: Error,
  ) {
    super(message, { cause });
    this.name = "NullGraphError";
  }
}

/**
 * Error thrown when infinite recursion is detected.
 */
export class RecursionError extends Error {
  constructor(subject: string) {
    super(subject);
    this.name = "RecursionError";
  }
}

export class SlotIndexError extends Error {
  constructor(
    message: string = "Attempted to access a slot that was out of bounds.",
    cause?: Error,
  ) {
    super(message, { cause });
    this.name = "SlotIndexError";
  }
}
