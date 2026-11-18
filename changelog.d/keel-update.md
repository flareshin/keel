### Added

- `keel update`, run from your own terminal, fast-forwards the keel checkout from its remote (`git pull --ff-only`) and prints the version and commit it moved from and to. It refuses and leaves the checkout unchanged when the pull is no fast-forward. `claude plugin update keel@keel` reports the folder's own version as the latest, because the marketplace is that folder; `docs/install.md` now says so. git-guard denies `keel update` to an agent (`F-hookskip`).
