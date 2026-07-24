/**
 * Workflow Base
 *
 * Shared infrastructure for PR and schedule workflows.
 */
import type { Octokit } from '@octokit/rest';
import type { EventContext, SkillReport } from '../../types/index.js';
import type { FindingObservation } from '../reporting/outcomes.js';
import type { ReplayTriggerResult } from '../reporting/output.js';
import type { BuildMetadataOutputV2Options, WardenFindingsV2, WardenMetadata } from '../reporting/output-v2.js';
import type { RuntimeName } from '../../sdk/runtimes/index.js';
import type { ActionInputs } from '../inputs.js';
import type { TriggerResult } from '../triggers/executor.js';
import type { ResolvedTrigger } from '../../config/loader.js';
/**
 * Sentinel error thrown by setFailed() so the top-level catch handler
 * can distinguish expected failures from unexpected crashes.
 */
export declare class ActionFailedError extends Error {
    constructor(message: string);
}
/**
 * Set a GitHub Actions output variable.
 */
export declare function setOutput(name: string, value: string | number): void;
/**
 * Fail the GitHub Action with an error message.
 * Throws ActionFailedError so spans end cleanly before the process exits.
 */
export declare function setFailed(message: string): never;
/** Validate Claude runtime auth before invoking the Claude Code SDK. */
export declare function ensureClaudeAuth(inputs: ActionInputs): void;
/**
 * Start a collapsible log group.
 */
export declare function logGroup(name: string): void;
/**
 * End a collapsible log group.
 */
export declare function logGroupEnd(): void;
export interface RuntimeEnvironment {
    pathToClaudeCodeExecutable?: string;
}
/** Prepare runtime-specific process dependencies required by matched triggers. */
export declare function prepareRuntimeEnvironment(triggers: Iterable<{
    runtime?: RuntimeName;
}>, inputs: ActionInputs): Promise<RuntimeEnvironment>;
/**
 * Find the Claude Code CLI executable path, installing it on demand when the
 * selected runtime needs Claude Code in CI.
 */
export declare function findClaudeCodeExecutable(): Promise<string>;
/**
 * Log trigger error summary and, by default, fail if all triggers failed.
 */
export declare function handleTriggerErrors(triggerErrors: string[], totalTriggers: number, options?: {
    failAll?: boolean;
}): void;
/**
 * Collect error messages from trigger results.
 */
export declare function collectTriggerErrors(results: TriggerResult[]): string[];
export interface WorkflowOutputs {
    findingsCount: number;
    highCount: number;
    summary: string;
}
/**
 * Compute workflow outputs from reports.
 */
export declare function computeWorkflowOutputs(reports: SkillReport[]): WorkflowOutputs;
/**
 * Set workflow output variables.
 */
export declare function setWorkflowOutputs(outputs: WorkflowOutputs): void;
/**
 * Get the authenticated bot's login name.
 *
 * Tries three strategies in order:
 * 1. GraphQL `viewer` query (works for both installation tokens and PATs)
 * 2. `octokit.apps.getAuthenticated()` → `${slug}[bot]` (GitHub App JWT fallback)
 * 3. `octokit.users.getAuthenticated()` (PAT fallback)
 */
export declare function getAuthenticatedBotLogin(octokit: Octokit): Promise<string | null>;
/**
 * Get the default branch for a repository from the GitHub API.
 */
export declare function getDefaultBranchFromAPI(octokit: Octokit, owner: string, repo: string): Promise<string>;
/**
 * Get the path for the findings output file.
 *
 * Uses the GitHub Actions workspace when available so action consumers can pass
 * the output to upload actions that expect repo-relative paths. Falls back to
 * RUNNER_TEMP for local callers and tests.
 */
export declare function getFindingsOutputPath(repoPath?: string): string;
/**
 * Write structured findings data to a JSON file for external export (GCS, S3, etc.).
 *
 * Sets `findings-file` to a repo-relative path when possible so downstream
 * steps can reference the path without tripping ignore processors on absolute
 * runner temp paths.
 */
export declare function writeFindingsOutput(reports: SkillReport[], context: EventContext, findingObservations?: FindingObservation[], options?: {
    triggerResults?: ReplayTriggerResult[];
    configuredSkills?: {
        name: string;
        triggered: boolean;
    }[];
}): string;
/**
 * Write the v1 findings file, then always run `writeV2` — even if the v1
 * write throws — since v2 consumers must never see a missing pair when v1
 * output was attempted. A v1 failure is reported through `onFailure` only
 * after `writeV2` has run, so callers that need a hard failure (e.g. analyze
 * mode, whose output feeds report mode) can pass a throwing handler without
 * risking the v2 write becoming unreachable.
 */
export declare function writeFindingsOutputs(writeV1: () => string, writeV2: () => void, onFailure: (message: string) => void, onSuccess?: (path: string) => void): void;
/** Get the path for the schema-v2 metadata output file. */
export declare function getMetadataOutputPath(repoPath?: string): string;
/** Get the path for the schema-v2 findings output file. */
export declare function getFindingsOutputPathV2(repoPath?: string): string;
/**
 * Write both schema-v2 files atomically, then set their action outputs
 * together, then mark the pair done with a sidecar file next to the
 * findings file.
 *
 * `metadata-file` and `findings-file` must never disagree on which schema
 * version they point at. Writing the two files independently (each setting
 * its own outputs as it goes) can leave `metadata-file` pointed at v2 while
 * a subsequent findings-file write failure leaves `findings-file` on
 * whatever v1 already set — a schema mismatch downstream consumers treat as
 * a hard error. Serializing both files to disk before setting any output
 * means a failure here leaves neither v2 output set, so a prior v1
 * `findings-file` output remains the last consistent value.
 *
 * This is the run's one true "done" checkpoint — every intermediate write
 * during the run goes through `writeSchemaV2OutputPairLive` instead, which
 * never touches the `.done` sidecar or these action outputs.
 */
export declare function writeSchemaV2OutputPair(metadata: WardenMetadata, findings: WardenFindingsV2, context: EventContext): {
    metadataPath: string;
    findingsPath: string;
};
/**
 * Write both schema-v2 files atomically, without the `.done` sidecar or any
 * action outputs. Used for the in-progress writes fired as each trigger
 * completes during a run; the real, single `.done`-marked write still
 * happens once via `writeSchemaV2OutputPair` after the run finishes. Never
 * throws — a transient write hiccup here must not abort a run the way a
 * final-write failure legitimately can.
 */
export declare function writeSchemaV2OutputPairLive(metadata: WardenMetadata, findings: WardenFindingsV2, context: EventContext): void;
/** Build and write the schema-v2 metadata/findings pair from raw trigger results. */
export declare function writeSchemaV2Output(context: EventContext, resolvedTriggers: ResolvedTrigger[], matchedTriggers: ResolvedTrigger[], results: TriggerResult[], findingObservations: FindingObservation[], options: BuildMetadataOutputV2Options): {
    metadataPath: string;
    findingsPath: string;
};
/** Build and write the in-progress schema-v2 metadata/findings pair from partial trigger results. */
export declare function writeSchemaV2OutputLive(context: EventContext, resolvedTriggers: ResolvedTrigger[], matchedTriggers: ResolvedTrigger[], results: TriggerResult[], findingObservations: FindingObservation[], options: BuildMetadataOutputV2Options): void;
/** Shared `{runId, runAttempt, actionRef, ...}` options every schema-v2 write site builds from `ActionInputs`. */
export declare function buildV2WriteOptions(inputs: ActionInputs): BuildMetadataOutputV2Options;
//# sourceMappingURL=base.d.ts.map