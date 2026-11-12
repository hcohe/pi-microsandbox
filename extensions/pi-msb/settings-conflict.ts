/** A stale approval or editor context must be reviewed again, never retried implicitly. */
export class SettingsConflictError extends Error {
  constructor() { super("Configuration changed; request a fresh review."); }
}
