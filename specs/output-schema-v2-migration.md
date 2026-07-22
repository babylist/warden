# Output Schema v2 Migration Guide

Warden's findings-file output has a new, opt-in schema (`output-schema-version: '2'`
on the action, default `'1'`). This guide maps every v1 field to its v2
equivalent for downstream consumers writing their own ingestion.

## Why

Two structural gaps in v1, raised in maintainer conversation about splitting a
"metadata" file out of the findings-centered file:

1. **Auxiliary-model rewrites were invisible per finding.** A verification pass
   can rewrite a finding's title/description/severity/confidence using a
   different model than the one that produced it, and a merge pass can fold
   sibling findings together. v1 tracked this only in aggregate, at the
   `SkillReport` level (`auxiliaryUsage`/`auxiliaryUsageAttribution`) — a
   reader couldn't tell, for one specific finding, whether it was rewritten,
   by what model, or what it looked like before.
2. **Cross-skill attribution only existed as GitHub comment text.** When
   multiple skills flag the same issue, the poster already tracks this
   (`ExistingComment.skills`) and renders "Identified by Warden skillA,
   skillB" into the PR comment — but that was invisible in the JSON, which
   nests each finding under whichever single skill's report happened to
   contain it.

Two concrete downstream pain points as well: consumers were hand-recomputing
per-skill severity breakdowns because only a global summary existed, and
hand-maintaining a harness-version constant because the output carried no
version identity.

## File split

Two files, joined by `runId` (+ `runAttempt` for re-runs). A reader should
treat a `runId`/`schemaVersion` mismatch between the two as a hard error.

- **`warden-metadata.json`** — static run context that isn't itself a skill
  result or a finding: repo/PR identity, harness version, resolved run-wide
  config, which skills/triggers were configured and whether they fired, and
  why any were skipped.
- **`warden-findings.json`** — everything that's a direct, detailed record of
  a skill executing and what it produced: skill executions (model, duration,
  cost, severity breakdown, errors — these are results, not context) and the
  findings themselves.

## Field mapping

### Envelope / identity

| v1 (`warden-findings.json`) | v2 | Notes |
|---|---|---|
| `version: '1'` | `schemaVersion: '2'` (both files) | |
| `timestamp` | `metadata.generatedAt` | |
| `runId` | `metadata.runId` and `findings.runId` | join key |
| — | `metadata.runAttempt` | new |
| — | `metadata.harness.name/version/actionRef` | new — `version` replaces hand-maintained `HARNESS_VERSION` env vars |
| `repository` | `metadata.repository` | unchanged shape |
| `event` | `metadata.event` | unchanged |
| `pullRequest` | `metadata.pullRequest` | unchanged shape |

### Skill execution stats

| v1 | v2 | Notes |
|---|---|---|
| `skills[]` | `findings.skillExecutions[]` | now keyed by `skillExecutionId`, not array position — a skill with multiple triggers (e.g. different models per action) gets one row per execution, disambiguated |
| `skills[].name` | `skillExecutions[].skillName` | |
| — | `skillExecutions[].skillExecutionId`, `.triggerId`, `.triggerName` | new — stable identity per skill×trigger |
| `skills[].model` | `skillExecutions[].model` | |
| — | `skillExecutions[].runtime`, `.auxiliaryModel`, `.synthesisModel` | new |
| `skills[].durationMs` | `skillExecutions[].durationMs` | |
| `skills[].usage` | `skillExecutions[].usage` | unchanged shape |
| — | `skillExecutions[].auxiliaryUsage[]` | new — array of `{agent, model, runtime, usage}`, replacing the record-keyed `SkillReport.auxiliaryUsage`/`auxiliaryUsageAttribution` maps for export purposes |
| `skills[].findings.length` (recomputed) | `skillExecutions[].findingIds.length` | |
| *(recomputed by hand from `skills[].findings[]`)* | `skillExecutions[].findingsBySeverity` | **fixed** — precomputed, no more manual recompute |
| `skills[].verifierRejections` | `skillExecutions[].verifierRejections` | unchanged shape |
| `skills[].failedHunks/.failedExtractions/.error` | `skillExecutions[].failedHunks/.failedExtractions/.error` | unchanged shape |

### Findings

| v1 | v2 | Notes |
|---|---|---|
| `skills[].findings[]` (nested per skill) | `findings[]` (flat, top-level) | a finding is no longer owned by exactly one skill array |
| `findings[].id/.severity/.confidence/.title/.description/.location/.additionalLocations/.sourceSnippet` | same fields on `findings[]` | unchanged |
| — | `findings[].contentHash` | new — stable cross-run key (same as `dedup.ts`'s `generateContentHash`) |
| *(dropped from export)* | `findings[].verification` | **fixed** — the verifier's evidence text was already rendered into GitHub comments but silently absent from v1 JSON |
| *(implicit, one skill only)* | `findings[].reportedBy[]` | new — `{skillExecutionId, skillName, role: 'primary'\|'corroborating', matchType?}`; a finding independently flagged by multiple skills now lists all of them |
| *(only in `auxiliaryUsage` aggregate)* | `findings[].provenance.verification` | new — `{outcome: 'kept'\|'revised', model, runtime, evidence?, before?}`; on `revised`, `before` holds the pre-revision title/description/severity/confidence |
| *(only in `auxiliaryUsage` aggregate)* | `findings[].provenance.merge` | new — `{model, runtime, absorbedFindingIds[]}` |
| *(not exported)* | `discardedFindings[]` | new, optional (omitted when empty) — verifier-rejected and merge-absorbed candidates that never reached `findings[]`, each with `{originSkillExecutionId, stage, severity, title, location?, model?, reason?, survivorFindingId?}` |

### Observability

| v1 | v2 | Notes |
|---|---|---|
| `configuredSkills[]` | `metadata.configuredSkills[]` | moved to metadata file, same shape |
| `triggerResults[]` | `metadata.triggerResults[]` | moved to metadata file; the embedded `report` field is dropped (that content now lives in `findings.skillExecutions`/`findings`) |
| *(not tracked)* | `metadata.skippedTriggers[]` | new — `{skillName, triggerId?, triggerName?, reason}`, reason is one of `no_event_match\|path_filter\|draft_state\|label_mismatch\|disabled` |
| `findingObservations[].skill` | `findingObservations[].origin.skillExecutionId/.skillName` | renamed/restructured |
| `findingObservations[].finding` | `findingObservations[].finding` | unchanged shape |
| `findingObservations[].dedupe` | `findingObservations[].dedupe` | unchanged, plus new `existingSkills[]` field (cross-skill attribution at the moment of the match) |
| `summary.totalFindings/.findingsBySeverity/.totalSkills` | `findings.summary.totalFindings/.bySeverity/.totalSkillExecutions` + `.byOutcome` | `totalSkillExecutions` replaces `totalSkills` since one skill can now have multiple executions; `byOutcome` is new |

## Two-phase `analyze`/`report` mode

v1's `TriggerRunResultSchema.report` (embedded in `triggerResults[]`) let
`report` mode replay a prior `analyze` run's output across a job boundary. In
v2 this content moves to `findings.skillExecutions`/`findings`, so `report`
mode reconstructs the same data by reading **both** v2 files and joining
`skillExecutions[]` (by `triggerId`) with `findings[]` (via `findingIds`)
instead of reading the embedded `report`.

## Rollout

`output-schema-version` defaults to `'1'`. Setting it to `'2'` writes both
`warden-metadata.json` and `warden-findings.json` in addition to the v1
`warden-findings.json` (v1's filename is unchanged; nothing currently
depending on it needs to change). There is no plan to flip the default
without a separate, explicitly announced deprecation window.
