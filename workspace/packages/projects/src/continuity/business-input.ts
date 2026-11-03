/** Native work exchanges that can make a normal main turn eligible for continuity. */
const BUSINESS_INPUTS = new Set(['user', 'project-delivery', 'project-schedule', 'project-execution-failure', 'agent-message', 'subagent-settled', 'user-question-reply', 'skill-invocation', 'schedule', 'webhook'])

/** Context snapshots, model selection and tool registry refreshes do not constitute work exchanges. */
export function isMainBusinessInput(kind: string): boolean { return BUSINESS_INPUTS.has(kind) }
