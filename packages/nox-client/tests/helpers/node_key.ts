/** A distinct 32-byte Sphinx key per label, so routes in tests have distinct keys. */
export function nodeKey(label: string): Uint8Array {
  const key = new Uint8Array(32).fill(0xab);
  new TextEncoder().encode(label).forEach((byte, i) => {
    key[i % 32] = (key[i % 32] ?? 0) ^ byte ^ ((i * 31) & 0xff);
  });
  return key;
}
