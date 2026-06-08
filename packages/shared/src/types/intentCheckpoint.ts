export interface IntentCheckpoint {
  schema_version: "intent-checkpoint/v1";
  confirmed_at: string;
  scope_summary: string;
  intent_summary: string;
  confirmed_by: "host";
}
