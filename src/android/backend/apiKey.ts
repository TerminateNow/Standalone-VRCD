/**
 * Browser-safe counterpart of src/shared/keyObfuscation.ts#decodeApiKey
 * (that one relies on Node's Buffer). The encoding is identical, so the same
 * VRSRC_API_KEY secret used for desktop builds works here.
 */
const MASK = 'vr-cyberdeck-build-obfuscation-mask-v1'

export function decodeApiKey(encoded: string): string {
  if (!encoded) return ''
  try {
    const bin = atob(encoded)
    const masked = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
    let out = ''
    for (let i = 0; i < masked.length; i++) {
      out += String.fromCharCode(masked.charCodeAt(i) ^ MASK.charCodeAt(i % MASK.length))
    }
    return out
  } catch {
    return ''
  }
}
