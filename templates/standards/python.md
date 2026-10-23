# Python standard

## Summary

- Modern, fully typed Python; code passes the repo's type checker in strict mode.
- `ruff` formats and lints; follow PEP 8 naming and the repo's layout.
- Explicit errors with specific exception types; never a bare `except`.
- `pytest` tests with plain `assert`, fixtures for setup, one behaviour per test.
- Dependencies come from the locked environment (`uv`); no ad-hoc installs.

## Naming and structure

- `snake_case` for functions, variables and modules; `PascalCase` for classes; `UPPER_SNAKE_CASE` for constants.
- Keep the package layout the repo already has (`src/` layout or flat). No new top-level packages for a single use.
- Modules expose a small public surface; prefix internals with `_`.
- No logic at import time beyond constants and definitions. Entry points use `if __name__ == "__main__":` or a console script.
- Prefer functions and dataclasses (`@dataclass(frozen=True, slots=True)`) over classes with mutable state.

## Types

- Annotate every public function, method and module-level variable.
- Use built-in generics (`list[str]`, `dict[str, int]`) and `X | None`.
- Use `typing.Protocol` for structural interfaces; avoid `Any`. Narrow with `isinstance`.
- Validate external data at the boundary (pydantic or the repo's validator) and pass typed objects inward.
- `# type: ignore` needs an error code and a reason.

## Errors

- Raise specific exceptions (built-in or a small project hierarchy); never `raise Exception`.
- Catch the narrowest exception you can handle; never `except:` or `except Exception: pass`.
- Chain with `raise ... from err` when translating errors.
- Use context managers (`with`) for files, locks, connections and temp dirs.

## Idioms

- Comprehensions for simple transforms; plain loops when there is logic.
- `pathlib.Path` instead of `os.path`; f-strings for formatting; `logging` instead of `print` in library code.
- Use the standard library first (`itertools`, `functools`, `collections`, `datetime` with time zones).
- No mutable default arguments.

## Security

- Never pass untrusted input to `eval`, `exec`, `pickle`, `yaml.load` (use `safe_load`) or `subprocess` with `shell=True`.
- Parameterise SQL. Use `secrets` for tokens, not `random`.
- Never log secrets or personal data. Read configuration from the environment or the repo's settings module.

## Testing

- `pytest` only; test files `test_*.py` under `tests/` (mirror the package layout).
- Plain `assert`; `pytest.raises` for errors; `pytest.mark.parametrize` for tables of cases.
- Fixtures for setup, `tmp_path` for files, `monkeypatch` for env; mock only process boundaries.
- Every spec scenario maps to at least one test whose name mentions the scenario.

## Anti-patterns

- Bare `except`, broad `except Exception` without re-raise.
- Mutable default args, star imports, global mutable state.
- Untyped public functions; `Any` leaking through APIs.
- Reformatting or reordering untouched code.
