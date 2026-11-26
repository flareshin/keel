### Fixed

- `measure/metrics/risk` takes the review-to-approval median of the unrounded waits and rounds it to a tenth of a minute; before, each wait was rounded to whole minutes first, which could tie light and standard where §6.1 asks whether light is below.
