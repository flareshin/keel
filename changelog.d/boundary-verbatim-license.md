### Changed
- The boundary scanner skips the text of a file named `LICENSE` only when its blob is byte-identical to the Apache-2.0 text; its path is still scanned, and any other content or file name is scanned as before.
