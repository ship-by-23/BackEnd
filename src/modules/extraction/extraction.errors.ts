import { extractionErrorCode } from "../../db/schema.js";

export type ExtractionErrorCode =
  (typeof extractionErrorCode.enumValues)[number];

export class ExtractionError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}
