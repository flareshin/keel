export const UNSUPPORTED_STDIN_CODECS = [
  "big5", "big5hkscs", "charmap", "cp037", "cp1006", "cp1026", "cp1125",
  "cp1140", "cp1250", "cp1253", "cp1254", "cp1255", "cp1256", "cp1257",
  "cp1258", "cp273", "cp424", "cp437", "cp500", "cp720", "cp737",
  "cp775", "cp850", "cp852", "cp855", "cp856", "cp857", "cp858",
  "cp860", "cp861", "cp862", "cp863", "cp864", "cp865", "cp869",
  "cp874", "cp875", "cp932", "cp949", "cp950", "euc_jis_2004", "euc_jisx0213",
  "euc_jp", "euc_kr", "gb18030", "gb2312", "gbk", "hp_roman8", "hz",
  "idna", "iso2022_jp", "iso2022_jp_1", "iso2022_jp_2", "iso2022_jp_2004", "iso2022_jp_3", "iso2022_jp_ext",
  "iso2022_kr", "iso8859_10", "iso8859_11", "iso8859_13", "iso8859_14", "iso8859_16", "iso8859_3",
  "iso8859_4", "iso8859_6", "iso8859_8", "iso8859_9", "johab", "koi8_t", "koi8_u",
  "kz1048", "mac_arabic", "mac_croatian", "mac_cyrillic", "mac_farsi", "mac_greek", "mac_iceland",
  "mac_latin2", "mac_roman", "mac_romanian", "mac_turkish", "palmos", "ptcp154", "punycode",
  "raw_unicode_escape", "shift_jis", "shift_jis_2004", "shift_jisx0213", "tis_620", "undefined", "unicode_escape",
  "utf_16", "utf_16_be", "utf_16_le", "utf_32", "utf_32_be", "utf_32_le", "utf_7",
] as const;

export interface StdinDivergence {
  codec: typeof UNSUPPORTED_STDIN_CODECS[number];
  encoding: string;
}

export function expectedStdinDeny(encoding: string): string {
  return `stdin encoding ${encoding} is not supported; set PYTHONUTF8=1`;
}
