export type VectorIndexDescriptor = {
  id: string;
  signature: string;
};

export function vectorContentSignature(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

function addRevisionValue(
  value: string,
  hashes: [number, number],
): [number, number] {
  let [hashA, hashB] = hashes;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    hashA = Math.imul(hashA ^ code, 0x01000193);
    hashB = Math.imul(hashB ^ code, 0x85ebca6b);
  }
  return [hashA, hashB];
}

function formatRevision(count: number, hashes: [number, number]): string {
  return `${count}:${(hashes[0] >>> 0).toString(16)}:${(hashes[1] >>> 0).toString(16)}`;
}

export function vectorDescriptorRevision(
  descriptors: VectorIndexDescriptor[],
): string {
  let hashes: [number, number] = [0x811c9dc5, 0x9e3779b9];
  for (const descriptor of descriptors) {
    hashes = addRevisionValue(
      `${descriptor.id}\x00${descriptor.signature}\x01`,
      hashes,
    );
  }
  return formatRevision(descriptors.length, hashes);
}

export function vectorTextRevision(texts: string[]): string {
  let hashes: [number, number] = [0x811c9dc5, 0x9e3779b9];
  for (let index = 0; index < texts.length; index++) {
    hashes = addRevisionValue(
      `${index}\x00${vectorContentSignature(texts[index])}\x01`,
      hashes,
    );
  }
  return formatRevision(texts.length, hashes);
}
