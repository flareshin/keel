# Changelog fragments

Each branch records its changelog entry in a file of its own here, `changelog.d/<change-name>.md`, with a name no other open branch uses (the branch name's last segment works). A new file cannot conflict with another branch's file, so merging `main` into a waiting branch no longer produces a `CHANGELOG.md` conflict whose resolution needs a delta review.

Do not edit the `[Unreleased]` section of `CHANGELOG.md`; it holds only a pointer here, and `tests/changelog/unreleased.test.ts` fails when it holds more.

A fragment is plain Markdown:

- Optional lead paragraphs first.
- Then entries under `### <category>` headings: `Added`, `Changed`, `Fixed`, `Removed` or `Upgrading`. Another `###` category is allowed and is placed after these.
- No other heading level.

At release, `bin/changelog <version> <YYYY-MM-DD>` prints the release section built from every fragment, in file-name order, with each category's entries gathered under one heading. `bin/changelog --write <version> <date>` writes that section into `CHANGELOG.md` and deletes the fragments.
