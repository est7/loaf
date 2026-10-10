# CLI terminator precedence

The first literal `--` separates option-bearing argv from positional data.
The raw scanner retains every token and its provenance. Bootstrap keeps the
following tokens as operands; presentation, selector and preparse policy views
exclude them from option recognition. Environment defaults still apply.
Commander remains responsible for positional arity and syntax errors.

The table records source CLI behavior before and after S04 with no selector
environment variables. Diagnostic stages distinguish equal exit/code pairs.

| Invocation | Before | After |
| --- | --- | --- |
| `status -- --format=yaml` | exit 2, `INVALID_FORMAT` | exit 2, Commander excess-argument `USAGE` |
| `status --format=json -- --plain` | exit 2, format mutex | exit 2, Commander excess-argument `USAGE`, JSON |
| `status --format=yaml -- --help` | exit 2, Commander `USAGE` after help bypass | exit 2, `INVALID_FORMAT` before Commander |
| `status -- --help` | exit 2, Commander `USAGE` after help bypass | exit 2, Commander excess-argument `USAGE`; no help bypass |
| `sessions list -- --feature=probe` | exit 2, selector conflict | exit 2, Commander excess-argument `USAGE` |
| `tasks submit -- --schema` | exit 2, Commander excess-argument `USAGE` | same; positional data is not schema mode |
| `hook unknown -- --list-events` | exit 0, hook event list | exit 2, unknown hook event before Commander |
| `check -- --feature=probe` | exit 2, selector conflict | exit 2, `INPUT_FILE_NOT_FOUND` for literal path `--feature=probe` |
| `spec schema -- --feature-dir=/tmp/x` | exit 2, schema selector conflict | exit 2, Commander excess-argument `USAGE` |
| `board --once -- --dry-run` | exit 2, Commander excess-argument `USAGE` | same; positional data is not dry-run mode |
| `-- sessions list --feature=probe` | exit 2, selector conflict | exit 2, Commander excess-argument `USAGE` |
| `status --feature-dir=/tmp/x -- --feature=probe` | exit 2, Commander excess-argument `USAGE` | exit 2, preparse feature-dir-requires-feature `USAGE` |

Pre-boundary `INVALID_FORMAT` still precedes format mutexes. Genuine
pre-boundary help/version retains its existing bypass. Post-boundary selectors
cannot replace a pre-boundary selector or suppress an environment selector.
A second `--` after the boundary is also positional data. Trace redaction and
editor tokenization retain their independent grammars.
