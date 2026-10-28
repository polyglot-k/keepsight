# Contributing

Thanks for your interest in KeepSight.

## Development setup

Requirements: macOS, Node.js 20+.

```sh
npm install                              # install dependencies
npm start                                # run the app against ~/artifacts
ARTIFACTS_ROOT=/tmp/scratch npm start    # run against a scratch folder
npm test                                 # run the test suite
npm run dist                             # build an unsigned .dmg/.zip into dist/
```

Use `ARTIFACTS_ROOT` while developing so you do not touch your real `~/artifacts`.

## Project layout

| Path | Contents |
|---|---|
| `app/` | Electron main process, preload, renderer (`index.html`), file store |
| `test/` | Tests, run with plain `node` |
| `skills/`, `hooks/`, `.claude-plugin/` | Claude Code plugin |
| `manage.sh` | Local install / launch helper |
| `docs/images/` | Screenshots used in the README |

## Code style

- Match the surrounding code; there is no formatter or linter.
- Add a JSDoc comment to every function.
- Spell names out (`filePath`, `activeItem`, `.pane-header`), including CSS classes and ids. Avoid abbreviations other than well-known ones like `url` or `html`.
- Keep shared file-format logic in `app/store.js`; the save script and the publish hook import it rather than copying it.
- Keep dependencies minimal. Prefer Node and Electron built-ins over new packages.
- Put tests in `test/` and write them with `node:assert`. No test framework.

## Pull requests

- [ ] One focused change per PR
- [ ] `npm test` passes
- [ ] Tested manually with `npm start` (use `ARTIFACTS_ROOT` for a scratch folder)
- [ ] New functions have JSDoc
- [ ] `CHANGELOG.md` updated under `Unreleased` for user-visible changes
- [ ] README updated if behavior or setup changed
