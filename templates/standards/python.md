# Python standard

<!-- Sources:
[pep8] PEP 8 – Style Guide for Python Code — https://peps.python.org/pep-0008/
[pep20] PEP 20 – The Zen of Python — https://peps.python.org/pep-0020/
[pep257] PEP 257 – Docstring Conventions — https://peps.python.org/pep-0257/
[typing] Typing Best Practices — https://typing.python.org/en/latest/reference/best_practices.html
[pep484] PEP 484 – Type Hints — https://peps.python.org/pep-0484/
[google-py] Google Python Style Guide — https://google.github.io/styleguide/pyguide.html
[pytest] pytest: Good Integration Practices — https://docs.pytest.org/en/stable/explanation/goodpractices.html
[pytest-fixtures] pytest: How to use fixtures — https://docs.pytest.org/en/stable/how-to/fixtures.html
[pytest-parametrize] pytest: How to parametrize fixtures and test functions — https://docs.pytest.org/en/stable/how-to/parametrize.html
[pytest-assert] pytest: How to write and report assertions in tests — https://docs.pytest.org/en/stable/how-to/assert.html
[pytest-monkeypatch] pytest: How to monkeypatch/mock modules and environments — https://docs.pytest.org/en/stable/how-to/monkeypatch.html
[pytest-tmp-path] pytest: How to use temporary directories and files in tests — https://docs.pytest.org/en/stable/how-to/tmp_path.html
[logging] Logging HOWTO — https://docs.python.org/3/howto/logging.html
[subprocess] subprocess – Security Considerations — https://docs.python.org/3/library/subprocess.html#security-considerations
[sqlite3] sqlite3 – How to use placeholders to bind values in SQL queries — https://docs.python.org/3/library/sqlite3.html
[dataclasses] dataclasses – Data Classes — https://docs.python.org/3/library/dataclasses.html
[pickle] pickle – Python object serialization (security warning) — https://docs.python.org/3/library/pickle.html
[secrets] secrets – Generate secure random numbers — https://docs.python.org/3/library/secrets.html
-->

## Summary

- Keep the repo's layout, tooling (uv/poetry/pip) and conventions; code must pass `ruff format`, `ruff check` and strict `pyright`/`mypy`.
- Follow PEP 8 naming; absolute imports grouped stdlib, third-party, local; no wildcard imports.
- Annotate every public function, including return types; use `X | None` and `list[int]`; avoid `Any`.
- Raise and catch specific exceptions, chain with `raise ... from`, keep `try` bodies small, never use bare `except:`.
- Log with `logging.getLogger(__name__)` and lazy `%s` arguments; never log secrets.
- Bind SQL parameters, pass subprocess arguments as lists, and never use `shell=True` with untrusted input.
- Test with pytest: plain `assert`, fixtures, `parametrize`, `tmp_path`, `monkeypatch`; name each test after its spec scenario.

## Project conventions

<!-- [pep20] explicit, simple, flat, easy to explain; [google-py] 3.17 Main -->
- Keep the existing package layout, dependency tool and conventions where they differ from this standard; add dependencies only through that tool. <!-- factory -->
- Let `ruff format` own layout; do not reformat or reorder code you did not change. <!-- factory -->
- Choose the explicit, flat, simple solution; if an implementation is hard to explain, redesign it.
- Put script behaviour in `main()` behind `if __name__ == "__main__":`; do nothing at import time beyond definitions.

## Naming

<!-- [pep8] Naming Conventions; [google-py] 3.16 Naming, 2.5 Mutable Global State -->
- `snake_case` for modules (no dashes), functions, methods and variables; `CapWords` for classes and type aliases.
- Exception classes end in `Error`; constants are module-level `UPPER_CASE`.
- One leading underscore marks non-public names; avoid `__mangled` names and mutable module-level state.
- Use descriptive names; single letters only for counters, `e` in handlers, `f` for files; never `l`, `O`, `I`.

## Imports

<!-- [pep8] Imports; [google-py] 2.2 Imports, 3.13 Imports formatting (stricter than pep8 on relative imports) -->
- Use absolute imports with the full package path; never `from module import *`.
- Imports go at the top after the module docstring, one per line, grouped `__future__`, stdlib, third-party, local, blank line between groups.
- Import abstract collection types (`Iterable`, `Mapping`, …) from `collections.abc`, not `typing`.

## Comparisons

<!-- [pep8] Programming Recommendations; [google-py] 2.14 True/False Evaluations -->
- Compare to `None` with `is` / `is not` (not `not x is None`); do not write `if x:` when you mean `if x is not None:`.
- Never compare booleans with `==`; test empty sequences with `if not seq:`, not `len(seq) == 0`.
- Use `isinstance()` rather than comparing `type()`; use `startswith()`/`endswith()` rather than slicing.

## Exceptions

<!-- [pep8] Programming Recommendations; [google-py] 2.4 Exceptions; [pep20] errors never pass silently -->
- Raise the most specific built-in (`ValueError` for bad arguments) or a project exception derived from `Exception`; name the failing value in the message.
- Catch only what you can handle; never bare `except:`. Catch `Exception` only to re-raise or at a deliberate isolation point that logs.
- Keep the `try` body to the statement that can fail; follow-up code goes in `else`, cleanup in `finally`.
- Chain translated errors so the cause survives:

  ```python
  try:
      port = int(raw)
  except ValueError as e:
      raise ConfigError(f"invalid port {raw!r}") from e
  ```
- Do not use `assert` for runtime checks in production code; raise instead.

## Functions and data

<!-- [google-py] 2.12 Default Argument Values, 2.13 Properties; [pep8] Programming Recommendations; [dataclasses] -->
- Never use a mutable default (list, dict, set, object); default to `None` and build it inside:

  ```python
  def add(item: str, bucket: list[str] | None = None) -> list[str]:
      if bucket is None:
          bucket = []
  ```
- Return consistently: every path returns a value (an explicit `return None` included) or none does. Use `def`, not a named lambda.
- Use `@dataclass` for records, `frozen=True` for values, `field(default_factory=list)` for mutable fields, `__post_init__` for validation.
- Use `@property` only for cheap, attribute-like computation; prefer a public attribute over a trivial getter/setter.
- Manage files, sockets, locks and connections with `with`; use `contextlib.closing()` for objects that lack context-manager support.

## Typing

<!-- [typing] Ergonomic Practices, Stylistic Practices; [pep484] The Any type; [google-py] 3.19 Type Annotations -->
- Annotate parameters and return types of every public function and method; unannotated parameters are implicit `Any`. <!-- factory -->
- Write `X | None` (None last) and `X | Y`, not `Optional`/`Union`; never rely on implicit optional (`x: str = None`).
- Use built-in generics (`list[str]`, `dict[str, int]`, `type[C]`), not `typing.List` and friends.
- Accept broad types (`Iterable`, `Sequence`, `Mapping`, a `Protocol`); return concrete ones (`list`, `dict`).
- Annotate a parameter that takes any value as `object`; reserve `Any` for what the type system cannot express.
- Avoid union return types that force callers into `isinstance()` checks; use `typing.Protocol` for structural interfaces.
- Every `# type: ignore[code]` names its error code and gives a reason. <!-- factory -->

## Docstrings

<!-- [pep257] One-line, Multi-line Docstrings; [google-py] 3.8 Comments and Docstrings -->
- Give every public module, class, function and method a `"""triple-double-quoted"""` docstring.
- Open with a one-line imperative summary ending in a period ("Return the user ID."); do not restate the signature.
- Multi-line: summary, blank line, details, then `Args:`, `Returns:`/`Yields:`, `Raises:` where they add information; document constructors in `__init__`.

## Logging and strings

<!-- [logging] Advanced Logging Tutorial, Configuring Logging for a Library, Optimization, When to use logging; [google-py] 3.10 Strings -->
- One logger per module: `logger = logging.getLogger(__name__)`; never log to the root logger in library code.
- Pass a constant format string plus arguments so formatting is deferred; no f-strings in logging calls:

  ```python
  logger.info("Loaded %d rows from %s", count, path)    # do
  logger.info(f"Loaded {count} rows from {path}")       # don't
  ```
- Call `logger.exception()` only inside `except`; choose the level by intent (debug, info, warning, error).
- Libraries add at most a `NullHandler`; only the application configures handlers. `print()` is for a CLI's user output only.
- Use f-strings for other formatting; accumulate strings with `"".join(...)`, not `+=` in a loop.

## Untrusted input

<!-- [subprocess] Security Considerations, Frequently Used Arguments; [sqlite3] placeholders; [pickle] warning; [secrets] -->
- Bind SQL values through the driver's placeholders (`cur.execute("... WHERE name = ?", (name,))`); never build SQL with f-strings, `%` or `+`. <!-- factory -->
- Run commands with an argument list and no shell; never `shell=True` with untrusted input. <!-- factory -->

  ```python
  subprocess.run(["git", "log", "--", user_path], check=True, timeout=30)
  ```
- Use `pathlib`, `glob` and `shutil` instead of shell pipelines and wildcards.
- Never unpickle data you did not produce: loading a pickle can run arbitrary code. Exchange data as JSON.
- Generate tokens, passwords and keys with `secrets` (`secrets.token_urlsafe()`), never `random`.
- Never log or print secrets, tokens, passwords or personal data, at any level. <!-- factory -->

## Testing

<!-- [pytest] Conventions for Python test discovery, Choosing a test layout; [pytest-fixtures]; [pytest-parametrize]; [pytest-assert]; [pytest-tmp-path]; [pytest-monkeypatch] -->
- Tests live only in `test_*.py`, `*_test.py`, `tests/` or `conftest.py`; the tester edits nothing else. <!-- factory -->
- Every spec scenario has at least one test named after it. <!-- factory -->
- Use `test_` functions or `Test` classes without `__init__`; follow the repo's existing test layout.
- Use plain `assert` (pytest shows operand values), `pytest.approx` for floats, `pytest.raises(Error, match=...)` around only the raising call.
- Inject setup via fixtures; tear down after `yield`; one state-changing action per fixture; share fixtures via `conftest.py`.
- Use `@pytest.mark.parametrize` for tables of cases instead of loops in a test:

  ```python
  @pytest.mark.parametrize(("raw", "expected"), [("1", 1), ("-2", -2)])
  def test_parse_int_accepts_signed_digits(raw: str, expected: int) -> None:
      assert parse_int(raw) == expected
  ```
- Use `tmp_path` (not `tmpdir`) for files and `monkeypatch` for env vars and attributes, patching the name where the code looks it up.
- Prefer passing dependencies in over patching; never patch builtins such as `open`.
