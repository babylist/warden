import { z } from 'zod';
import type { AuxiliaryUsageAttributionMap, AuxiliaryUsageMap, EventContext, SeverityThreshold } from '../../types/index.js';
import type { ResolvedTrigger } from '../../config/loader.js';
import type { TriggerResult } from '../triggers/executor.js';
import type { FindingObservation } from './outcomes.js';
export declare const SeverityBreakdownSchema: z.ZodObject<{
    high: z.ZodNumber;
    medium: z.ZodNumber;
    low: z.ZodNumber;
}, z.core.$strip>;
export type SeverityBreakdown = z.infer<typeof SeverityBreakdownSchema>;
export declare const SkippedTriggerReasonSchema: z.ZodEnum<{
    no_event_match: "no_event_match";
    path_filter: "path_filter";
    draft_state: "draft_state";
    label_mismatch: "label_mismatch";
    no_changes: "no_changes";
}>;
export declare const TriggerRunResultV2Schema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"success">;
    triggerId: z.ZodOptional<z.ZodString>;
    triggerName: z.ZodString;
    skillName: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"error">;
    triggerId: z.ZodOptional<z.ZodString>;
    triggerName: z.ZodString;
    skillName: z.ZodString;
    error: z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>], "status">;
export declare const WardenMetadataSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<"2">;
    runId: z.ZodString;
    runAttempt: z.ZodOptional<z.ZodString>;
    generatedAt: z.ZodString;
    harness: z.ZodObject<{
        name: z.ZodLiteral<"warden">;
        version: z.ZodString;
        actionRef: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    repository: z.ZodObject<{
        owner: z.ZodString;
        name: z.ZodString;
        fullName: z.ZodString;
    }, z.core.$strip>;
    event: z.ZodEnum<{
        pull_request: "pull_request";
        schedule: "schedule";
        issues: "issues";
        issue_comment: "issue_comment";
        pull_request_review: "pull_request_review";
        pull_request_review_comment: "pull_request_review_comment";
    }>;
    pullRequest: z.ZodOptional<z.ZodObject<{
        number: z.ZodNumber;
        author: z.ZodString;
        title: z.ZodString;
        baseBranch: z.ZodString;
        headBranch: z.ZodString;
        headSha: z.ZodString;
    }, z.core.$strip>>;
    configuredSkills: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        triggered: z.ZodBoolean;
    }, z.core.$strip>>>;
    skippedTriggers: z.ZodOptional<z.ZodArray<z.ZodObject<{
        skillName: z.ZodString;
        triggerId: z.ZodOptional<z.ZodString>;
        triggerName: z.ZodOptional<z.ZodString>;
        reason: z.ZodEnum<{
            no_event_match: "no_event_match";
            path_filter: "path_filter";
            draft_state: "draft_state";
            label_mismatch: "label_mismatch";
            no_changes: "no_changes";
        }>;
    }, z.core.$strip>>>;
    triggerResults: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        status: z.ZodLiteral<"success">;
        triggerId: z.ZodOptional<z.ZodString>;
        triggerName: z.ZodString;
        skillName: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        status: z.ZodLiteral<"error">;
        triggerId: z.ZodOptional<z.ZodString>;
        triggerName: z.ZodString;
        skillName: z.ZodString;
        error: z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>], "status">>>;
    resolvedDefaults: z.ZodOptional<z.ZodObject<{
        failOn: z.ZodOptional<z.ZodPreprocess<z.ZodEnum<{
            off: "off";
            low: "low";
            medium: "medium";
            high: "high";
        }>>>;
        reportOn: z.ZodOptional<z.ZodPreprocess<z.ZodEnum<{
            off: "off";
            low: "low";
            medium: "medium";
            high: "high";
        }>>>;
        minConfidence: z.ZodOptional<z.ZodEnum<{
            off: "off";
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        model: z.ZodOptional<z.ZodString>;
        auxiliaryModel: z.ZodOptional<z.ZodString>;
        synthesisModel: z.ZodOptional<z.ZodString>;
        runtime: z.ZodOptional<z.ZodString>;
        verifyFindings: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type WardenMetadata = z.infer<typeof WardenMetadataSchema>;
declare const AuxiliaryUsageEntrySchema: z.ZodObject<{
    agent: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    runtime: z.ZodOptional<z.ZodString>;
    usage: z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadInputTokens: z.ZodOptional<z.ZodNumber>;
        cacheCreationInputTokens: z.ZodOptional<z.ZodNumber>;
        cacheCreation5mInputTokens: z.ZodOptional<z.ZodNumber>;
        cacheCreation1hInputTokens: z.ZodOptional<z.ZodNumber>;
        webSearchRequests: z.ZodOptional<z.ZodNumber>;
        costUSD: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const SkillExecutionSchema: z.ZodObject<{
    skillExecutionId: z.ZodString;
    skillName: z.ZodString;
    triggerId: z.ZodOptional<z.ZodString>;
    triggerName: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    runtime: z.ZodOptional<z.ZodString>;
    auxiliaryModel: z.ZodOptional<z.ZodString>;
    synthesisModel: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
    durationMs: z.ZodOptional<z.ZodNumber>;
    usage: z.ZodOptional<z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadInputTokens: z.ZodOptional<z.ZodNumber>;
        cacheCreationInputTokens: z.ZodOptional<z.ZodNumber>;
        cacheCreation5mInputTokens: z.ZodOptional<z.ZodNumber>;
        cacheCreation1hInputTokens: z.ZodOptional<z.ZodNumber>;
        webSearchRequests: z.ZodOptional<z.ZodNumber>;
        costUSD: z.ZodNumber;
    }, z.core.$strip>>;
    auxiliaryUsage: z.ZodOptional<z.ZodArray<z.ZodObject<{
        agent: z.ZodString;
        model: z.ZodOptional<z.ZodString>;
        runtime: z.ZodOptional<z.ZodString>;
        usage: z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadInputTokens: z.ZodOptional<z.ZodNumber>;
            cacheCreationInputTokens: z.ZodOptional<z.ZodNumber>;
            cacheCreation5mInputTokens: z.ZodOptional<z.ZodNumber>;
            cacheCreation1hInputTokens: z.ZodOptional<z.ZodNumber>;
            webSearchRequests: z.ZodOptional<z.ZodNumber>;
            costUSD: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>>;
    findingsBySeverity: z.ZodObject<{
        high: z.ZodNumber;
        medium: z.ZodNumber;
        low: z.ZodNumber;
    }, z.core.$strip>;
    findingIds: z.ZodArray<z.ZodString>;
    failedHunks: z.ZodOptional<z.ZodNumber>;
    failedExtractions: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodEnum<{
            unknown: "unknown";
            auth_failed: "auth_failed";
            provider_unavailable: "provider_unavailable";
            sdk_error: "sdk_error";
            subprocess_failure: "subprocess_failure";
            max_turns: "max_turns";
            aborted: "aborted";
            all_hunks_failed: "all_hunks_failed";
            invalid_model_selector: "invalid_model_selector";
            skill_resolution_failed: "skill_resolution_failed";
            extraction_invalid_json: "extraction_invalid_json";
            extraction_unbalanced_json: "extraction_unbalanced_json";
            extraction_no_findings_json: "extraction_no_findings_json";
            extraction_missing_findings_key: "extraction_missing_findings_key";
            extraction_findings_not_array: "extraction_findings_not_array";
            extraction_llm_failed: "extraction_llm_failed";
            extraction_llm_timeout: "extraction_llm_timeout";
            extraction_no_api_key: "extraction_no_api_key";
        }>;
        message: z.ZodString;
        timestamp: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    verifierRejections: z.ZodOptional<z.ZodObject<{
        count: z.ZodNumber;
        reasons: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type SkillExecution = z.infer<typeof SkillExecutionSchema>;
declare const VerificationStageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    outcome: z.ZodLiteral<"kept">;
    model: z.ZodOptional<z.ZodString>;
    runtime: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    outcome: z.ZodLiteral<"revised">;
    model: z.ZodOptional<z.ZodString>;
    runtime: z.ZodOptional<z.ZodString>;
    evidence: z.ZodOptional<z.ZodString>;
    before: z.ZodObject<{
        title: z.ZodString;
        description: z.ZodString;
        severity: z.ZodPreprocess<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        confidence: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
    }, z.core.$strip>;
}, z.core.$strip>], "outcome">;
declare const MergeStageSchema: z.ZodObject<{
    model: z.ZodOptional<z.ZodString>;
    runtime: z.ZodOptional<z.ZodString>;
    absorbedFindingIds: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type VerificationStage = z.infer<typeof VerificationStageSchema>;
export type MergeStage = z.infer<typeof MergeStageSchema>;
declare const FindingProvenanceSchema: z.ZodObject<{
    originSkillExecutionId: z.ZodString;
    originModel: z.ZodOptional<z.ZodString>;
    verification: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        outcome: z.ZodLiteral<"kept">;
        model: z.ZodOptional<z.ZodString>;
        runtime: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        outcome: z.ZodLiteral<"revised">;
        model: z.ZodOptional<z.ZodString>;
        runtime: z.ZodOptional<z.ZodString>;
        evidence: z.ZodOptional<z.ZodString>;
        before: z.ZodObject<{
            title: z.ZodString;
            description: z.ZodString;
            severity: z.ZodPreprocess<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            confidence: z.ZodOptional<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
        }, z.core.$strip>;
    }, z.core.$strip>], "outcome">>;
    merge: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        runtime: z.ZodOptional<z.ZodString>;
        absorbedFindingIds: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type FindingProvenance = z.infer<typeof FindingProvenanceSchema>;
declare const FindingAttributionSchema: z.ZodObject<{
    skillExecutionId: z.ZodString;
    skillName: z.ZodString;
    role: z.ZodEnum<{
        primary: "primary";
        corroborating: "corroborating";
    }>;
    matchType: z.ZodOptional<z.ZodEnum<{
        hash: "hash";
        semantic: "semantic";
    }>>;
}, z.core.$strip>;
export type FindingAttribution = z.infer<typeof FindingAttributionSchema>;
export declare const ExportedFindingV2Schema: z.ZodObject<{
    id: z.ZodString;
    contentHash: z.ZodString;
    severity: z.ZodPreprocess<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>>;
    confidence: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>>;
    title: z.ZodString;
    description: z.ZodString;
    verification: z.ZodOptional<z.ZodString>;
    location: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        startLine: z.ZodNumber;
        endLine: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    additionalLocations: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        startLine: z.ZodNumber;
        endLine: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
    sourceSnippet: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        language: z.ZodOptional<z.ZodString>;
        startLine: z.ZodNumber;
        endLine: z.ZodNumber;
        targetStartLine: z.ZodNumber;
        targetEndLine: z.ZodNumber;
        lines: z.ZodArray<z.ZodObject<{
            line: z.ZodNumber;
            content: z.ZodString;
            highlighted: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    reportedBy: z.ZodArray<z.ZodObject<{
        skillExecutionId: z.ZodString;
        skillName: z.ZodString;
        role: z.ZodEnum<{
            primary: "primary";
            corroborating: "corroborating";
        }>;
        matchType: z.ZodOptional<z.ZodEnum<{
            hash: "hash";
            semantic: "semantic";
        }>>;
    }, z.core.$strip>>;
    provenance: z.ZodObject<{
        originSkillExecutionId: z.ZodString;
        originModel: z.ZodOptional<z.ZodString>;
        verification: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            outcome: z.ZodLiteral<"kept">;
            model: z.ZodOptional<z.ZodString>;
            runtime: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            outcome: z.ZodLiteral<"revised">;
            model: z.ZodOptional<z.ZodString>;
            runtime: z.ZodOptional<z.ZodString>;
            evidence: z.ZodOptional<z.ZodString>;
            before: z.ZodObject<{
                title: z.ZodString;
                description: z.ZodString;
                severity: z.ZodPreprocess<z.ZodEnum<{
                    low: "low";
                    medium: "medium";
                    high: "high";
                }>>;
                confidence: z.ZodOptional<z.ZodEnum<{
                    low: "low";
                    medium: "medium";
                    high: "high";
                }>>;
            }, z.core.$strip>;
        }, z.core.$strip>], "outcome">>;
        merge: z.ZodOptional<z.ZodObject<{
            model: z.ZodOptional<z.ZodString>;
            runtime: z.ZodOptional<z.ZodString>;
            absorbedFindingIds: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type ExportedFindingV2 = z.infer<typeof ExportedFindingV2Schema>;
export declare const DiscardedFindingSchema: z.ZodObject<{
    originSkillExecutionId: z.ZodString;
    stage: z.ZodEnum<{
        verification_rejected: "verification_rejected";
        merge_absorbed: "merge_absorbed";
    }>;
    severity: z.ZodPreprocess<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>>;
    title: z.ZodString;
    location: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        startLine: z.ZodNumber;
        endLine: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    model: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
    survivorFindingId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type DiscardedFinding = z.infer<typeof DiscardedFindingSchema>;
export declare const DedupeDetailV2Schema: z.ZodObject<{
    source: z.ZodEnum<{
        warden: "warden";
        external: "external";
    }>;
    matchType: z.ZodEnum<{
        hash: "hash";
        semantic: "semantic";
    }>;
    existingFindingId: z.ZodOptional<z.ZodString>;
    existingCommentId: z.ZodOptional<z.ZodNumber>;
    existingThreadId: z.ZodOptional<z.ZodString>;
    existingResolved: z.ZodOptional<z.ZodBoolean>;
    existingSkills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    actor: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type DedupeDetailV2 = z.infer<typeof DedupeDetailV2Schema>;
export declare const FindingObservationV2Schema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    outcome: z.ZodLiteral<"posted">;
    origin: z.ZodObject<{
        skillExecutionId: z.ZodString;
        skillName: z.ZodString;
    }, z.core.$strip>;
    finding: z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodPreprocess<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        confidence: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        title: z.ZodString;
        description: z.ZodString;
        location: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            startLine: z.ZodNumber;
            endLine: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        elapsedMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    outcome: z.ZodLiteral<"deduped">;
    origin: z.ZodObject<{
        skillExecutionId: z.ZodString;
        skillName: z.ZodString;
    }, z.core.$strip>;
    finding: z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodPreprocess<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        confidence: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        title: z.ZodString;
        description: z.ZodString;
        location: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            startLine: z.ZodNumber;
            endLine: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        elapsedMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    dedupe: z.ZodObject<{
        source: z.ZodEnum<{
            warden: "warden";
            external: "external";
        }>;
        matchType: z.ZodEnum<{
            hash: "hash";
            semantic: "semantic";
        }>;
        existingFindingId: z.ZodOptional<z.ZodString>;
        existingCommentId: z.ZodOptional<z.ZodNumber>;
        existingThreadId: z.ZodOptional<z.ZodString>;
        existingResolved: z.ZodOptional<z.ZodBoolean>;
        existingSkills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        actor: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    outcome: z.ZodLiteral<"skipped">;
    origin: z.ZodObject<{
        skillExecutionId: z.ZodString;
        skillName: z.ZodString;
    }, z.core.$strip>;
    finding: z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodPreprocess<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        confidence: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        title: z.ZodString;
        description: z.ZodString;
        location: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            startLine: z.ZodNumber;
            endLine: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        elapsedMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    skippedReason: z.ZodEnum<{
        max_findings: "max_findings";
        duplicate_in_batch: "duplicate_in_batch";
        no_inline_location: "no_inline_location";
    }>;
}, z.core.$strip>, z.ZodObject<{
    outcome: z.ZodLiteral<"resolved">;
    origin: z.ZodObject<{
        skillExecutionId: z.ZodString;
        skillName: z.ZodString;
    }, z.core.$strip>;
    finding: z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodPreprocess<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        confidence: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        title: z.ZodString;
        description: z.ZodString;
        location: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            startLine: z.ZodNumber;
            endLine: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        elapsedMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    resolvedReason: z.ZodEnum<{
        fix_evaluation: "fix_evaluation";
        stale_check: "stale_check";
    }>;
}, z.core.$strip>, z.ZodObject<{
    outcome: z.ZodLiteral<"failed">;
    origin: z.ZodObject<{
        skillExecutionId: z.ZodString;
        skillName: z.ZodString;
    }, z.core.$strip>;
    finding: z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodPreprocess<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        confidence: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        title: z.ZodString;
        description: z.ZodString;
        location: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            startLine: z.ZodNumber;
            endLine: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        elapsedMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>], "outcome">;
export type FindingObservationV2 = z.infer<typeof FindingObservationV2Schema>;
declare const SummarySchema: z.ZodObject<{
    totalFindings: z.ZodNumber;
    totalSkillExecutions: z.ZodNumber;
    bySeverity: z.ZodObject<{
        high: z.ZodNumber;
        medium: z.ZodNumber;
        low: z.ZodNumber;
    }, z.core.$strip>;
    byOutcome: z.ZodObject<{
        posted: z.ZodNumber;
        deduped: z.ZodNumber;
        skipped: z.ZodNumber;
        resolved: z.ZodNumber;
        failed: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export type SummaryV2 = z.infer<typeof SummarySchema>;
export declare const WardenFindingsSchemaV2: z.ZodObject<{
    schemaVersion: z.ZodLiteral<"2">;
    runId: z.ZodString;
    skillExecutions: z.ZodArray<z.ZodObject<{
        skillExecutionId: z.ZodString;
        skillName: z.ZodString;
        triggerId: z.ZodOptional<z.ZodString>;
        triggerName: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        runtime: z.ZodOptional<z.ZodString>;
        auxiliaryModel: z.ZodOptional<z.ZodString>;
        synthesisModel: z.ZodOptional<z.ZodString>;
        summary: z.ZodString;
        durationMs: z.ZodOptional<z.ZodNumber>;
        usage: z.ZodOptional<z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadInputTokens: z.ZodOptional<z.ZodNumber>;
            cacheCreationInputTokens: z.ZodOptional<z.ZodNumber>;
            cacheCreation5mInputTokens: z.ZodOptional<z.ZodNumber>;
            cacheCreation1hInputTokens: z.ZodOptional<z.ZodNumber>;
            webSearchRequests: z.ZodOptional<z.ZodNumber>;
            costUSD: z.ZodNumber;
        }, z.core.$strip>>;
        auxiliaryUsage: z.ZodOptional<z.ZodArray<z.ZodObject<{
            agent: z.ZodString;
            model: z.ZodOptional<z.ZodString>;
            runtime: z.ZodOptional<z.ZodString>;
            usage: z.ZodObject<{
                inputTokens: z.ZodNumber;
                outputTokens: z.ZodNumber;
                cacheReadInputTokens: z.ZodOptional<z.ZodNumber>;
                cacheCreationInputTokens: z.ZodOptional<z.ZodNumber>;
                cacheCreation5mInputTokens: z.ZodOptional<z.ZodNumber>;
                cacheCreation1hInputTokens: z.ZodOptional<z.ZodNumber>;
                webSearchRequests: z.ZodOptional<z.ZodNumber>;
                costUSD: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>>>;
        findingsBySeverity: z.ZodObject<{
            high: z.ZodNumber;
            medium: z.ZodNumber;
            low: z.ZodNumber;
        }, z.core.$strip>;
        findingIds: z.ZodArray<z.ZodString>;
        failedHunks: z.ZodOptional<z.ZodNumber>;
        failedExtractions: z.ZodOptional<z.ZodNumber>;
        error: z.ZodOptional<z.ZodObject<{
            code: z.ZodEnum<{
                unknown: "unknown";
                auth_failed: "auth_failed";
                provider_unavailable: "provider_unavailable";
                sdk_error: "sdk_error";
                subprocess_failure: "subprocess_failure";
                max_turns: "max_turns";
                aborted: "aborted";
                all_hunks_failed: "all_hunks_failed";
                invalid_model_selector: "invalid_model_selector";
                skill_resolution_failed: "skill_resolution_failed";
                extraction_invalid_json: "extraction_invalid_json";
                extraction_unbalanced_json: "extraction_unbalanced_json";
                extraction_no_findings_json: "extraction_no_findings_json";
                extraction_missing_findings_key: "extraction_missing_findings_key";
                extraction_findings_not_array: "extraction_findings_not_array";
                extraction_llm_failed: "extraction_llm_failed";
                extraction_llm_timeout: "extraction_llm_timeout";
                extraction_no_api_key: "extraction_no_api_key";
            }>;
            message: z.ZodString;
            timestamp: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        verifierRejections: z.ZodOptional<z.ZodObject<{
            count: z.ZodNumber;
            reasons: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    findings: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        contentHash: z.ZodString;
        severity: z.ZodPreprocess<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        confidence: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        title: z.ZodString;
        description: z.ZodString;
        verification: z.ZodOptional<z.ZodString>;
        location: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            startLine: z.ZodNumber;
            endLine: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        additionalLocations: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            startLine: z.ZodNumber;
            endLine: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>>;
        sourceSnippet: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            language: z.ZodOptional<z.ZodString>;
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
            targetStartLine: z.ZodNumber;
            targetEndLine: z.ZodNumber;
            lines: z.ZodArray<z.ZodObject<{
                line: z.ZodNumber;
                content: z.ZodString;
                highlighted: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        reportedBy: z.ZodArray<z.ZodObject<{
            skillExecutionId: z.ZodString;
            skillName: z.ZodString;
            role: z.ZodEnum<{
                primary: "primary";
                corroborating: "corroborating";
            }>;
            matchType: z.ZodOptional<z.ZodEnum<{
                hash: "hash";
                semantic: "semantic";
            }>>;
        }, z.core.$strip>>;
        provenance: z.ZodObject<{
            originSkillExecutionId: z.ZodString;
            originModel: z.ZodOptional<z.ZodString>;
            verification: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                outcome: z.ZodLiteral<"kept">;
                model: z.ZodOptional<z.ZodString>;
                runtime: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                outcome: z.ZodLiteral<"revised">;
                model: z.ZodOptional<z.ZodString>;
                runtime: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                before: z.ZodObject<{
                    title: z.ZodString;
                    description: z.ZodString;
                    severity: z.ZodPreprocess<z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>>;
                    confidence: z.ZodOptional<z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>>;
                }, z.core.$strip>;
            }, z.core.$strip>], "outcome">>;
            merge: z.ZodOptional<z.ZodObject<{
                model: z.ZodOptional<z.ZodString>;
                runtime: z.ZodOptional<z.ZodString>;
                absorbedFindingIds: z.ZodArray<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    discardedFindings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        originSkillExecutionId: z.ZodString;
        stage: z.ZodEnum<{
            verification_rejected: "verification_rejected";
            merge_absorbed: "merge_absorbed";
        }>;
        severity: z.ZodPreprocess<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        title: z.ZodString;
        location: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            startLine: z.ZodNumber;
            endLine: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        model: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        survivorFindingId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    findingObservations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        outcome: z.ZodLiteral<"posted">;
        origin: z.ZodObject<{
            skillExecutionId: z.ZodString;
            skillName: z.ZodString;
        }, z.core.$strip>;
        finding: z.ZodObject<{
            id: z.ZodString;
            severity: z.ZodPreprocess<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            confidence: z.ZodOptional<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            title: z.ZodString;
            description: z.ZodString;
            location: z.ZodOptional<z.ZodObject<{
                path: z.ZodString;
                startLine: z.ZodNumber;
                endLine: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            elapsedMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        outcome: z.ZodLiteral<"deduped">;
        origin: z.ZodObject<{
            skillExecutionId: z.ZodString;
            skillName: z.ZodString;
        }, z.core.$strip>;
        finding: z.ZodObject<{
            id: z.ZodString;
            severity: z.ZodPreprocess<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            confidence: z.ZodOptional<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            title: z.ZodString;
            description: z.ZodString;
            location: z.ZodOptional<z.ZodObject<{
                path: z.ZodString;
                startLine: z.ZodNumber;
                endLine: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            elapsedMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        dedupe: z.ZodObject<{
            source: z.ZodEnum<{
                warden: "warden";
                external: "external";
            }>;
            matchType: z.ZodEnum<{
                hash: "hash";
                semantic: "semantic";
            }>;
            existingFindingId: z.ZodOptional<z.ZodString>;
            existingCommentId: z.ZodOptional<z.ZodNumber>;
            existingThreadId: z.ZodOptional<z.ZodString>;
            existingResolved: z.ZodOptional<z.ZodBoolean>;
            existingSkills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            actor: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        outcome: z.ZodLiteral<"skipped">;
        origin: z.ZodObject<{
            skillExecutionId: z.ZodString;
            skillName: z.ZodString;
        }, z.core.$strip>;
        finding: z.ZodObject<{
            id: z.ZodString;
            severity: z.ZodPreprocess<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            confidence: z.ZodOptional<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            title: z.ZodString;
            description: z.ZodString;
            location: z.ZodOptional<z.ZodObject<{
                path: z.ZodString;
                startLine: z.ZodNumber;
                endLine: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            elapsedMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        skippedReason: z.ZodEnum<{
            max_findings: "max_findings";
            duplicate_in_batch: "duplicate_in_batch";
            no_inline_location: "no_inline_location";
        }>;
    }, z.core.$strip>, z.ZodObject<{
        outcome: z.ZodLiteral<"resolved">;
        origin: z.ZodObject<{
            skillExecutionId: z.ZodString;
            skillName: z.ZodString;
        }, z.core.$strip>;
        finding: z.ZodObject<{
            id: z.ZodString;
            severity: z.ZodPreprocess<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            confidence: z.ZodOptional<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            title: z.ZodString;
            description: z.ZodString;
            location: z.ZodOptional<z.ZodObject<{
                path: z.ZodString;
                startLine: z.ZodNumber;
                endLine: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            elapsedMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        resolvedReason: z.ZodEnum<{
            fix_evaluation: "fix_evaluation";
            stale_check: "stale_check";
        }>;
    }, z.core.$strip>, z.ZodObject<{
        outcome: z.ZodLiteral<"failed">;
        origin: z.ZodObject<{
            skillExecutionId: z.ZodString;
            skillName: z.ZodString;
        }, z.core.$strip>;
        finding: z.ZodObject<{
            id: z.ZodString;
            severity: z.ZodPreprocess<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            confidence: z.ZodOptional<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            title: z.ZodString;
            description: z.ZodString;
            location: z.ZodOptional<z.ZodObject<{
                path: z.ZodString;
                startLine: z.ZodNumber;
                endLine: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            elapsedMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>], "outcome">>;
    summary: z.ZodObject<{
        totalFindings: z.ZodNumber;
        totalSkillExecutions: z.ZodNumber;
        bySeverity: z.ZodObject<{
            high: z.ZodNumber;
            medium: z.ZodNumber;
            low: z.ZodNumber;
        }, z.core.$strip>;
        byOutcome: z.ZodObject<{
            posted: z.ZodNumber;
            deduped: z.ZodNumber;
            skipped: z.ZodNumber;
            resolved: z.ZodNumber;
            failed: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type WardenFindingsV2 = z.infer<typeof WardenFindingsSchemaV2>;
/** Inverse of {@link toAuxiliaryUsageEntries} — rebuilds the record-keyed shape SkillReport expects. */
export declare function fromAuxiliaryUsageEntries(entries: z.infer<typeof AuxiliaryUsageEntrySchema>[] | undefined): {
    usage: AuxiliaryUsageMap | undefined;
    attribution: AuxiliaryUsageAttributionMap | undefined;
};
export interface BuildMetadataOutputV2Options {
    runId: string;
    runAttempt?: string;
    generatedAt?: string;
    actionRef?: string;
    /** Action-level fallback used by every trigger via `trigger.failOn ?? inputs.failOn`. */
    failOn?: SeverityThreshold;
    /** Action-level fallback used by every trigger via `trigger.reportOn ?? inputs.reportOn`. */
    reportOn?: SeverityThreshold;
}
export declare function buildMetadataOutputV2(context: EventContext, resolvedTriggers: ResolvedTrigger[], matchedTriggers: ResolvedTrigger[], results: TriggerResult[], options: BuildMetadataOutputV2Options): WardenMetadata;
/**
 * Rebuild only the observation-derived parts of a v2 findings payload:
 * `findingObservations`, `summary.byOutcome`, and any newly-discovered
 * cross-skill corroboration on `findings[].reportedBy`. Used by report mode
 * to fold real posting outcomes into an analyze-phase payload without
 * touching `skillExecutions`/`discardedFindings`/`provenance`, which can
 * only be reconstructed from the original `findingProcessingEvents` and
 * would otherwise be silently wiped by a full rebuild from replayed
 * results. Corroboration is additive-only (existing `reportedBy` entries
 * are never removed) since it can only be discovered once posting/dedup
 * runs, which analyze mode never does.
 */
export declare function patchFindingsOutputV2Observations(base: WardenFindingsV2, matchedTriggers: ResolvedTrigger[], findingObservations: FindingObservation[]): WardenFindingsV2;
export interface BuildFindingsOutputV2Options {
    runId: string;
}
export declare function buildFindingsOutputV2(results: TriggerResult[], matchedTriggers: ResolvedTrigger[], findingObservations: FindingObservation[], options: BuildFindingsOutputV2Options): WardenFindingsV2;
export {};
//# sourceMappingURL=output-v2.d.ts.map