# Helm / Kubernetes standard

## Summary

- Charts pass `helm lint`, render with `helm template` and validate with `kubeconform -strict`.
- Every configurable value is documented in `values.yaml` and typed in `values.schema.json`.
- Workloads are secure by default: non-root, read-only root filesystem, no privilege escalation, resource requests and limits.
- No secrets in charts or values; reference existing Secrets.
- Chart tests (`helm unittest`) cover each spec scenario.

## Structure

- Keep the chart layout the repo already has. Templates live in `templates/`, helpers in `_helpers.tpl`.
- Name templates `<chart>.<thing>` in `_helpers.tpl`; use `include`, not `template`.
- Use the standard labels (`app.kubernetes.io/name`, `instance`, `version`, `component`, `part-of`, `managed-by`) via one helper.
- Bump `version` in `Chart.yaml` for every chart change (SemVer); `appVersion` tracks the application.

## Values and schema

- `values.yaml` holds safe defaults and a comment for every key.
- `values.schema.json` types every value, marks required ones and sets bounds (`minimum`, `enum`, `pattern`). Adding a value means updating the schema in the same change.
- Never remove or rename a value without a deprecation path; consumers depend on it (it is a contract).
- Quote strings in templates (`{{ .Values.x | quote }}`); use `required` for mandatory values.
- Use `toYaml` with `nindent` for nested structures; keep whitespace control (`{{-`) consistent.

## Workload security

- `securityContext`: `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, drop all capabilities.
- Set resource requests and limits; define liveness and readiness probes.
- Pin images by tag from values (digest preferred); never `latest` in defaults for production charts.
- Least-privilege RBAC: namespaced `Role` over `ClusterRole`, only the verbs needed.
- No `hostPath`, `hostNetwork` or privileged containers unless the task requires them.

## Secrets and config

- Never put secret values in `values.yaml`, templates or tests; reference Secrets by name.
- ConfigMaps for non-secret configuration; checksum annotations to roll pods on change.

## Testing

- `helm unittest` suites in `tests/*_test.yaml` per template; assert on rendered fields, not whole documents.
- CI value files in `ci/*-values.yaml` for alternative configurations; each must render and validate.
- Every spec scenario maps to at least one test whose name mentions the scenario.

## Anti-patterns

- Hard-coded namespaces, names or image tags in templates.
- Values without schema entries; untyped `values.schema.json` (`additionalProperties` everywhere).
- Logic-heavy templates that belong in the application.
- Breaking value renames without deprecation.
