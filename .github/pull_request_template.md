## Summary

<!--
In What changed, lead with the problem, task, or value for plugin users or
reviewers, then explain the implementation. Use Why for the motivation or
tradeoff; not every change needs to describe a bug.

In 1–3 plain sentences, say who is affected, what happens today, and why it
matters to them. For a bug, name the trigger if known. For a feature or internal
work, describe the need in the actual workflow without inventing harm.
Could a reader understand the problem without knowing your proposed fix?

Good: "Background checks can use up a new user's model allowance before they've
asked the assistant to monitor anything."
Bad: "Turn off periodic checks on fresh installs."

Illustrative wording, not claims about this PR:
- Implementation-first: "Refactor the transactional install code."
- Reader-first: "Failed plugin installs should leave the previous plugin usable;
  keep the previous files until the replacement succeeds."
-->
- What changed:
- Why:
- Related issue:

## Compatibility

- Source app(s):
- Affected surface(s):
- Trust-boundary or execution impact:

## Verification

<!--
Explain what validation established before listing commands or logs. Connect
the outcome to the affected plugin surface or task, and state failures, skipped
checks, and limitations without presenting them as passes.

Illustrative wording, not an additional test requirement:
- Command-only: "Ran the install tests."
- Outcome-first: "The failed-install fixture retained the previous plugin files;
  the focused install tests passed."
-->
- [ ] Added or updated focused tests.
- [ ] Ran `npm run check`.
- [ ] Ran `npm run pack:check`.
- [ ] Updated the README compatibility table when behavior changed.
- [ ] Updated `CHANGELOG.md` for user-visible or operational changes.
- [ ] Removed secrets, private paths, and generated artifacts from the diff.
