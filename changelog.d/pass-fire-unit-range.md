### Changed

- ship-gate: every judged `pass` or `deny` fire line now carries `base`, the merge-base the judgment diffed from, so `base..head` names the shipped unit and a later fix can be tied to the ship it fixes without rebuilding units from reflogs.
