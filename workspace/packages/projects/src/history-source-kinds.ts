/** Browser-safe vocabulary for sources whose bodies are intentionally absent from native Chat. */
export const PROJECT_HISTORY_RAW_REFERENCE_TYPES = ['projects/assistant-progress-v2', 'projects/tool-raw-v2', 'projects/tool-execution-return-v2', 'projects/tool-execution-final-v2'] as const;
export const PROJECT_HISTORY_RAW_LEGACY_TYPES = ['projects/assistant-progress', 'projects/tool-raw', 'projects/tool-execution-return', 'projects/tool-execution-final'] as const;
export const PROJECT_HISTORY_RAW_RECORD_TYPES = [...PROJECT_HISTORY_RAW_REFERENCE_TYPES, ...PROJECT_HISTORY_RAW_LEGACY_TYPES] as const;
const rawTypes = new Set<string>(PROJECT_HISTORY_RAW_RECORD_TYPES);
export function isProjectUiRawRecordType(type: string): boolean { return rawTypes.has(type); }
