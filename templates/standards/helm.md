# Helm / Kubernetes standard

<!-- Sources:
[helm-bp] Helm Chart Best Practices — https://helm.sh/docs/chart_best_practices/
[helm-charts] Charts (Chart.yaml, Dependencies, CRDs) — https://helm.sh/docs/topics/charts/
[helm-schema] Charts: Schema Files — https://helm.sh/docs/topics/charts/#schema-files
[helm-tips] Chart Development Tips and Tricks — https://helm.sh/docs/howto/charts_tips_and_tricks/
[helm-funcs] Template Function List — https://helm.sh/docs/chart_template_guide/function_list/
[helm-tests] Chart Tests — https://helm.sh/docs/topics/chart_tests/
[helm-unittest] helm-unittest README and test API — https://github.com/helm-unittest/helm-unittest
[k8s-config] Configuration Good Practices — https://kubernetes.io/docs/concepts/configuration/overview/
[k8s-images] Images — https://kubernetes.io/docs/concepts/containers/images/
[k8s-resources] Resource Management for Pods and Containers — https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
[pss] Pod Security Standards — https://kubernetes.io/docs/concepts/security/pod-security-standards/
[probes] Configure Liveness, Readiness and Startup Probes — https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
[probes-concept] Liveness, Readiness, and Startup Probes — https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/
[labels] Recommended Labels — https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/
[k8s-rbac] Role Based Access Control Good Practices — https://kubernetes.io/docs/concepts/security/rbac-good-practices/
-->

## Summary

- Keep the repo's chart layout, naming and value structure; `Chart.yaml` uses `apiVersion: v2` and a SemVer 2 `version`.
- Values are camelCase, strings quoted, every key commented starting with its name, and typed in `values.schema.json`.
- `values.schema.json` is a contract: update it with every values change and keep it backwards compatible unless the spec says otherwise.
- Templates use chart-prefixed `define` names, `include … | nindent`, `required` for mandatory values, and standard labels on every resource.
- Containers meet the restricted Pod Security Standard, pin image tags (never `latest`), set requests and limits, and define probes.
- No secret values in values, templates or tests; reference existing Secrets by name.
- Every spec scenario has a named helm-unittest test in `tests/*_test.yaml`; alternative configurations live in `ci/*-values.yaml`.

## Chart metadata and dependencies

<!-- [helm-bp] General Conventions; Templates: Structure of templates/; Dependencies; Custom Resource Definitions; [helm-charts] The Chart.yaml File, Chart Dependencies, Limitations on CRDs; [helm-tips] Partials -->
- Keep the repo's existing chart layout, file names and value structure where they differ from this standard. <!-- factory -->
- Use `apiVersion: v2`. Chart names: lowercase letters, digits and dashes, alphanumeric at both ends, ≤ 63 characters.
- `version` is SemVer 2; `appVersion` tracks the application independently and is quoted (`appVersion: "1.0"`).
- Bump `version` with every change to the chart. <!-- factory -->
- Indent YAML with two spaces, never tabs. New templates: `.yaml` for manifests, `.tpl` for helpers, dashed names that include the kind (`api-service.yaml`), one resource per file; helpers go in `_helpers.tpl`.
- Declare dependencies with patch-level ranges (`version: ~1.2.3`) and `https://` repositories; gate optional ones with `condition: <name>.enabled`.
- Put CRDs as plain YAML (no template directives) in `crds/` or a separate chart; Helm installs them once and never upgrades or deletes them.

## Values and schema

<!-- [helm-bp] Values: Naming Conventions, Flat or Nested Values, Make Types Clear, Consider How Users Will Use Your Values, Document values.yaml; [helm-schema]; [k8s-config] General configuration tips -->
- Name keys camelCase starting lowercase (`serverPort`, not `ServerPort`/`server-port`); read dashed subchart keys with `index .Values "sub-chart" "key"`.
- Prefer flat keys; nest only a group of related settings where at least one is mandatory.
- Quote string values; leave ints and booleans bare; write booleans only as `true`/`false`; store large integers as strings and convert with `int`.
- Prefer maps keyed by name over lists of objects so `--set servers.foo.port=80` keeps working.
- Comment every key, starting with the key name: `# replicaCount is the number of pods the Deployment runs.`
- The schema validates the merged values, subchart schemas included, on install, upgrade, `helm lint` and `helm template`.
- Change `values.schema.json` in the same commit as any values change: type each new key; add `enum`, `minimum` or `pattern` where meaningful. <!-- factory -->
- Do not remove, rename or narrow existing values; add new ones as optional with defaults that keep current output, unless the spec says otherwise. <!-- factory -->
- Never put secret values in `values.yaml`, templates, tests or `ci/` files; take an existing Secret's name and use `secretKeyRef`/`envFrom`. <!-- factory -->

## Templates

<!-- [helm-bp] Templates: Names of Defined Templates, Formatting Templates, Comments; [helm-tips] Quote Strings, include, required, Automatically Roll Deployments; [helm-funcs] fail, nindent -->
- Prefix every `define` with the chart name (`"mychart.fullname"`, never `"fullname"`); defined templates are global across parent and subcharts.
- Call helpers with `include`, not `template`, so output can be piped; render nested values with `toYaml` and `nindent`:

```yaml
  labels:
    {{- include "mychart.labels" . | nindent 4 }}
  resources:
    {{- toYaml .Values.resources | nindent 4 }}
```

- Write `{{ .Values.x }}` with inner spaces; chomp with `{{-`/`-}}`, but chomping both sides can join lines, so check rendered output.
- Pipe strings through `quote`; leave integers unquoted (env var `value`s are strings, so quote them).
- Fail early: `required "image.repository is required" .Values.image.repository` for mandatory values, `fail` for invalid combinations.
- Document helpers with `{{- /* … */ -}}` comments; never put `required` inside a `#` YAML comment, which still renders.
- Roll pods on config change with `checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}`.

## Labels and selectors

<!-- [helm-bp] Labels and Annotations: Standard Labels; Pods and PodTemplates: PodTemplates Should Declare Selectors; [labels]; [k8s-config] Working with labels -->
- Build labels in one `<chart>.labels` helper applied to every resource: `app.kubernetes.io/name`, `app.kubernetes.io/instance: {{ .Release.Name }}`, `app.kubernetes.io/managed-by: {{ .Release.Service }}`, `helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}`; add `version`, `component`, `part-of` where meaningful.
- Use labels only for metadata used to select or query; everything else, including Helm hooks, is an annotation.
- Give every PodTemplate an explicit `selector` from stable labels (`name`, `instance`); never select on `version` or `helm.sh/chart`.

## Images and resources

<!-- [helm-bp] Pods and PodTemplates: Images, ImagePullPolicy; [k8s-images] Image pull policy; [k8s-resources] Requests and limits, Resource units -->
- Take `image.repository`, `image.tag` (or digest) and `image.pullPolicy` from values; default to a fixed tag or digest, never `latest`, `head` or `canary`.
- Default `pullPolicy: IfNotPresent`; if omitted, Kubernetes uses `Always` for `latest` or untagged images and never revisits it after creation.
- Set CPU and memory `requests` and `limits` from values. Requests drive scheduling; a lone limit also becomes the request; CPU over limit is throttled, memory over limit is OOM-killed.
- Write CPU as millicores (`250m`) and memory as `Mi`/`Gi`; lowercase `m` on memory means millibytes (`400m` is 0.4 bytes).

## Probes

<!-- [probes]; [probes-concept] -->
- Define a readiness probe so Services route traffic only to ready pods; it runs for the container's whole life.
- A liveness probe must signal only unrecoverable failure (e.g. a deadlock); one that fails under load causes cascading restarts.
- For slow starters add a `startupProbe` with `failureThreshold × periodSeconds` ≥ worst-case startup; liveness and readiness wait for it. Point `httpGet`/`tcpSocket` probes at named ports.

## Pod security and RBAC

<!-- [pss] Baseline and Restricted policies; [k8s-config] Managing workloads, hostPort and hostNetwork; [helm-bp] Role-Based Access Control; [k8s-rbac] Least privilege -->
- Every container, init containers included, meets the restricted profile:

```yaml
securityContext:
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  seccompProfile: { type: RuntimeDefault }
  capabilities: { drop: ["ALL"] }
```

- Never set `runAsUser: 0` or `privileged: true`; add no capability except `NET_BIND_SERVICE`.
- No `hostNetwork`, `hostPID`, `hostIPC`, `hostPort` or `hostPath`; use only configMap, secret, emptyDir, projected, downwardAPI, csi, ephemeral or persistentVolumeClaim volumes.
- Run pods through a controller (Deployment, StatefulSet, Job), never as naked Pods.
- Set `automountServiceAccountToken: false` unless the workload calls the Kubernetes API.
- Keep `rbac.create` (boolean, default `true`) separate from `serviceAccount.create` and `serviceAccount.name`; resolve the name in a `<chart>.serviceAccountName` helper (set name, else fullname if created, else `default`).
- Grant least privilege: namespaced `Role`/`RoleBinding` over cluster-wide ones, only needed verbs and resources, no `*` wildcards, never `cluster-admin`.

## Tests

<!-- [helm-unittest] README, DOCUMENT.md assertion types; [helm-tests] -->
- Unit tests are helm-unittest suites in `tests/*_test.yaml`; the tester may edit only these and `ci/*-values.yaml`. <!-- factory -->
- Every spec scenario maps to at least one test whose `it:` is named after the scenario. <!-- factory -->
- Each test sets inputs via `set`/`values` and asserts specific paths (`equal`, `exists`, `notExists`, `contains`, `isKind`, `hasDocuments`); use `failedTemplate` for `required`, `fail` and schema errors.
- Every `ci/*-values.yaml` must render, pass the schema and validate with kubeconform. <!-- factory -->
- In-cluster `helm test` hooks are Pods/Jobs in `templates/tests/` annotated `"helm.sh/hook": test`; they pass on exit code 0.
