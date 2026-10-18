export const RISU_SAVE_BLOCK_HEADER_BYTES = [
  82, 73, 83, 85, 83, 65, 86, 69, 0,
] as const;

export const LEGACY_RAW_DATABASE_HEADER_BYTES = [
  0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7,
] as const;

export const LEGACY_COMPRESSED_DATABASE_HEADER_BYTES = [
  0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8,
] as const;

export const LEGACY_STREAM_COMPRESSED_DATABASE_HEADER_BYTES = [
  0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9,
] as const;
