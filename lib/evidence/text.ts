import { InvalidUtf8Error } from '../../measure/lib/measurekit/files.ts';

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeStrict(bytes: Uint8Array, source: string): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new InvalidUtf8Error(`${source} is not valid UTF-8`);
  }
}

export function words(text: string): string[] {
  const trimmed = text.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}
