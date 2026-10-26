// AUTO-GENERATED — DO NOT EDIT

export type AppError = { code: "NOT_FOUND"|"VALIDATION"|"CONFLICT"|"IO"|"DB"; message: string };

export interface NoteSummary {
  id: string;
  folder_id: string;
  title: string;
  year: number;
  is_favorite: boolean;
  content_locked?: boolean;
  exported_at: string | null;
  has_image: boolean;
  tag_names: string[];
  region: string | null;
  region_names?: string[];
  status: string | null;
  icon: string | null;
  lat: number | null;
  lng: number | null;
  created_at: string;
  updated_at: string;
  month: number | null;
  day: number | null;
  end_year?: number | null;
  end_month?: number | null;
  end_day?: number | null;
  remind?: boolean;
  start_time?: string | null;
  end_time?: string | null;
  remind_offset_min?: number | null;
  rrule?: string | null;
  snippet?: string | null;
}

export interface NoteDetail {
  note: NoteSummary;
  sections: Section[];
  sources: Source[];
  attachments: Attachment[];
}

export interface Section {
  id: string;
  name: string;
  body_md: string;
  position: number;
  kind: 'text' | 'diagram' | 'sheet';
  ai_origin?: string | null;
  updated_at?: string | null;
}

export interface Source {
  id: string;
  name: string;
  ext: string;
  body: string;
  position: number;
  truncated?: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  kind: 'image' | 'doc' | 'link' | 'audio' | 'note' | 'internal' | 'chart';
  rel_path: string | null;
  url: string | null;
  ext_path?: string | null;
  size_bytes: number | null;
  position: number;
  transcript?: string | null;
  transcript_inserted?: boolean;
}

export interface Folder {
  id: string;
  workspace_id: string;
  name: string;
  position: number;
  is_open: boolean;
  note_count: number;
  color_hue: number | null;
  icon: string | null;
  rules: string | null;
  search_excluded: boolean;
  ai_excluded: boolean;
}

export interface ActivityItem {
  id: string;
  workspace_id: string;
  note_id: string | null;
  kind: string;
  summary: string;
  payload: string | null;
  created_at: string;
  note_title: string | null;
  note_alive: boolean;
}

export interface AiPlanAction {
  action_id: string;
  kind: 'create_note' | 'update_note' | 'delete_note' | 'merge_notes';
  payload: { note_id?: string, source_note_ids?: string[], title?: string, body_md?: string, folder_id?: string };
}

export interface AiPlanScope {
  note_revisions: { [key: string]: string };
  note_folder_ids: { [key: string]: string };
  folder_ids: string[];
}

export interface AiPlanActionResult {
  action_id: string;
  status: 'applied' | 'already_applied' | 'failed';
  note_id?: string;
  error?: string;
}

export interface AiHistoryItem {
  id: string;
  workspace_id: string;
  note_id?: string;
  action_type: 'operation.outcome';
  prompt_or_input?: string;
  result_text: string;
  created_at: string;
}

export interface AiUsageRow {
  workspace_id: string;
  day: string;
  action_type: string;
  provider: string;
  calls: number;
}

export interface CallLogEntry {
  ts: string;
  id: string;
  op?: string;
  caller?: string;
  provider: string;
  model: string;
  fallback_used: boolean;
  note_id?: string;
  attempts: number;
  http_status?: number;
  duration_ms?: number;
  prompt_bytes: number;
  response_bytes?: number;
  outcome?: 'ok' | 'error' | 'deadline' | 'cancelled';
  error?: string;
  prompt_head?: string;
  response_head?: string;
  request_id?: string;
  discard_reason?: string;
}

export interface CallsSummary {
  total: number;
  by_outcome: { [key: string]: number };
  by_provider: { [key: string]: number };
  median_duration_ms?: number;
  p90_duration_ms?: number;
  discard_reasons: { [key: string]: number };
}

export interface AttachmentThumb {
  id: string;
  rel_path: string;
}

export interface AttachmentQueryItem {
  id: string;
  note_id: string;
  name: string;
  kind: string;
  rel_path: string | null;
  size_bytes: number | null;
  created_at: string;
  title: string;
  year: number;
  thumb_rel_path: string | null;
}

export interface CollectedNote {
  note_id: string;
  title: string;
  excerpt: string | null;
  source_id: string | null;
  source_name: string | null;
  source_kind: string | null;
  collected_at: string;
  tags: string[];
}

export interface BriefingNoteQuote {
  note_id: string;
  title: string;
  text: string;
}

export interface RecentWorkNote {
  note_id: string;
  title: string;
  folder_name: string | null;
  last_at: string;
}

export interface CalendarMark {
  id: string;
  workspace_id: string;
  source_id: string | null;
  uid: string | null;
  title: string;
  year: number | null;
  month: number;
  day: number;
  repeat: string;
  lunar: boolean;
  day_off: boolean;
  color_hue: number | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarSource {
  id: string;
  workspace_id: string;
  name: string;
  url: string | null;
  enabled: boolean;
  color_hue: number | null;
  fetched_at: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CalendarMarkHide {
  source: string;
  iso_day: string;
}

export interface CalendarMarkImport {
  uid: string | null;
  title: string;
  year: number | null;
  month: number;
  day: number;
  repeat: string;
  day_off: boolean;
}

export interface CaptureStatus {
  ledger_enabled: boolean;
  running: boolean;
  port: number;
  token: string;
}

export interface DetectedChatSession {
  id: string;
  kind: string;
  project: string;
  title: string;
  last_prompt: string;
  prompt_count: number;
  last_active_at: string | null;
  relative_time: string;
}

export interface CollectSource {
  id: string;
  workspace_id: string;
  kind: string;
  name: string;
  config: string;
  enabled: boolean;
  dry_run: boolean;
  show_in_briefing: boolean;
  target_folder_id: string | null;
  post_process: string;
  post_process_model: string | null;
  interval_minutes: number | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DryRunItem {
  title: string;
  guid: string;
  seen: boolean;
  preview: string;
}

export interface CollectActionStat {
  action_type: string;
  calls: number;
  providers: CollectProviderBreakdown[];
}

export interface CollectProviderBreakdown {
  provider: string;
  calls: number;
}

export interface LocalCandidate {
  key: string;
  kind: string;
  label: string;
  detail: string;
  recent_count: number;
  last_seen_at: string | null;
  source_id: string | null;
  config: string;
}

export interface BoardTodoItem {
  section_id: string;
  line_index: number;
  text: string;
  checked: boolean;
}

export interface BoardNote {
  id: string;
  title: string;
  year: number;
  month: number | null;
  day: number | null;
  end_year: number | null;
  end_month: number | null;
  end_day: number | null;
  remind: boolean;
  updated_at: string;
  unchecked_count: number;
  items: BoardTodoItem[];
}

export interface BoardColumn {
  status: string | null;
  status_label: string | null;
  notes: BoardNote[];
}

export interface BoardResult {
  columns: BoardColumn[];
  total_matched: number;
  cap: number;
  capped: boolean;
}

export interface TodoToggleResult {
  note_id: string;
  section_id: string;
  line_index: number;
  checked: boolean;
  updated_at: string;
}

export interface CalendarItem {
  note_id: string;
  folder_id: string;
  title: string;
  kind: string;
  span_start: string;
  span_end: string;
  year: number;
  month: number | null;
  day: number | null;
  end_year: number | null;
  end_month: number | null;
  end_day: number | null;
  start_time: string | null;
  end_time: string | null;
  is_occurrence: boolean | null;
  remind: boolean;
  date_id: string;
  position: number;
  remind_offset_min: number | null;
  rrule: string | null;
}

export interface CalendarResult {
  year: number;
  month: number;
  items: CalendarItem[];
}

export interface TimelineNoteItem {
  note_id: string;
  title: string;
  kind: string;
  year: number;
  month: number | null;
  day: number | null;
  end_year: number | null;
  end_month: number | null;
  end_day: number | null;
  folder_id: string;
}

export interface TimelineYearBucket {
  folder_id: string;
  year: number;
  count: number;
}

export interface TimelineEra {
  id: string;
  name: string;
  from_year: number;
  to_year: number;
  position: number;
}

export interface TimelineResult {
  from_year: number;
  to_year: number;
  items: TimelineNoteItem[];
  year_buckets: TimelineYearBucket[];
  eras: TimelineEra[];
  total_matched: number;
  cap: number;
  capped: boolean;
}

export interface GraphNode {
  id: string;
  folder_id: string;
  title: string;
  year: number;
  snippet: string;
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: 'backlink' | 'related';
  weight: number;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total: number;
  cap: number;
  capped: boolean;
  edge_total: number;
  edge_cap: number;
  edges_capped: boolean;
}

export interface CoverImageResult {
  note_id: string;
  rel_path: string | null;
  attachment_id: string | null;
}

export interface DueReminder {
  note_id: string;
  title: string;
  kind: string;
  fire_at: string | null;
  related_date_id: string | null;
}

export interface ScheduleTodayResult {
  items: DueReminder[];
}

export interface DiagEntry {
  id: string;
  ts: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  feature: string;
  code: string;
  message: string;
  count: number;
}

export interface DiagWorkerStatus {
  name: string;
  last_beat: string | null;
  state: 'alive' | 'stale' | 'stopped';
}

export interface DiagNotice {
  feature: string;
  code: string;
  params: { [key: string]: string };
  ts: string;
}

export interface DocExportSection {
  name: string;
  doc: unknown;
}

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
}

export interface Habit {
  id: string;
  workspace_id: string;
  title: string;
  icon: string | null;
  hue: number | null;
  weekday_mask: number;
  position: number;
  archived_at: string | null;
  created_at: string;
  time_of_day: string;
}

export interface HabitDay {
  day: string;
  scheduled: boolean;
  done: boolean;
}

export interface HabitWeekRow {
  habit: Habit;
  days: HabitDay[];
  done_count: number;
  scheduled_count: number;
  rate: number | null;
  streak: number;
}

export interface HabitWeek {
  from: string;
  to: string;
  today: string;
  rows: HabitWeekRow[];
  done_count: number;
  scheduled_count: number;
  rate: number | null;
}

export interface HabitHistoryDay {
  day: string;
  scheduled: number;
  done: number;
}

export interface HabitHistory {
  from: string;
  to: string;
  days: HabitHistoryDay[];
}

export interface NoteFiles {
  note_id: string;
  title: string;
  attachments: Attachment[];
}

export interface NoteRegion {
  id: string;
  note_id: string;
  name: string;
  lat: number;
  lng: number;
  position: number;
}

export interface RegionRegistryEntry {
  name: string;
  lat: number;
  lng: number;
}

export interface NoteDate {
  id: string;
  note_id: string;
  position: number;
  year: number;
  month: number | null;
  day: number | null;
  end_year: number | null;
  end_month: number | null;
  end_day: number | null;
  remind: boolean;
  created_at: string;
  start_time: string | null;
  end_time: string | null;
  remind_offset_min: number | null;
  rrule: string | null;
  label: string | null;
}

export interface PetSearchHit {
  note_id: string;
  title: string;
  snippet: string;
}

export interface PetAsset {
  mood: string;
  kind: string;
  frames?: number;
  cycle_ms?: number;
  data_url: string;
}

export interface PetPackageClip {
  name: string;
  row: number;
  frames: number;
}

export interface PetInstallFailure {
  name: string;
  reason: string;
}

export interface PetPackage {
  id: string;
  display_name: string;
  description: string;
  sprite_version_number: number;
  rows: number;
  selected: boolean;
  dialect: string;
  has_preview: boolean;
  clips: PetPackageClip[];
}

export interface PetMessage {
  role: string;
  text: string;
  created_at: string;
  meta?: string;
}

export interface PetSessionSummary {
  id: string;
  title: string;
  live: boolean;
  created_at: string;
  closed_at?: string;
  message_count: number;
  preview: string;
}

export interface PetNotification {
  kind: string;
  note_id?: string;
  text: string;
}

export interface RoutineToggleResult {
  note_id: string;
  occur_on: string;
  done: boolean;
}

export interface RoutineTodayItem {
  note_id: string;
  title: string;
  done: boolean;
  time: string | null;
}

export interface RoutineTodayResult {
  items: RoutineTodayItem[];
}

export interface RoutineDay {
  date: string;
  done: number;
  due: number;
}

export interface RoutineHistoryResult {
  days: RoutineDay[];
  from: string;
  to: string;
}

export interface SectionTrashEntry {
  id: string;
  name: string;
  kind: string;
  note_id: string;
  note_title: string;
  note_deleted: boolean;
  deleted_at: string;
}

export interface DocImportDropped {
  kind: string;
  count: number;
}

export interface SnapshotMeta {
  id: string;
  taken_at: string;
}

export interface SnapshotListItem {
  id: string;
  taken_at: string;
  section_count: number;
}

export interface SnapshotSection {
  section_id: string;
  title: string;
  kind: string;
  body_md: string;
}

export interface SnapshotDetail {
  id: string;
  note_id: string;
  taken_at: string;
  sections: SnapshotSection[];
}

export interface RestoreResult {
  note_id: string;
  updated_at: string;
  restored_count: number;
  recreated_count: number;
  extra_count: number;
  safety_snapshot_id: string;
}

export interface Suggestion {
  id: string;
  kind: string;
  note_id: string;
  note_title: string;
  related_note_id: string;
  related_note_title: string;
  payload: string;
  score: number;
  created_at: string;
}

export interface SyncStatus {
  enabled: boolean;
  running: boolean;
  bound_addr: string | null;
  port: number;
  token: string;
  url: string | null;
  qr_svg: string | null;
  bind_stale: boolean;
}

export interface TimelineRoutine {
  id: string;
  workspace_id: string;
  title: string;
  weekday_mask: number;
  start_time: string;
  end_time: string;
  color_hue: number | null;
  skip_holidays: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface WeatherEntry {
  time: string;
  temp_c: number;
  symbol_1h: string | null;
  symbol_6h: string | null;
  temp_max_6h: number | null;
  temp_min_6h: number | null;
  humidity_pct?: number | null;
  wind_ms?: number | null;
  pressure_hpa?: number | null;
  uv_index?: number | null;
  precip_mm?: number | null;
  precip_prob_pct?: number | null;
}

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
  folder_count: number;
  note_count: number;
  bg_image_path: string | null;
  icon: string | null;
}

export interface RegionEntry {
  id: string;
  workspace_id: string;
  name: string;
  position: number;
}

export interface EraEntry {
  id: string;
  workspace_id: string;
  name: string;
  from_year: number;
  to_year: number;
  position: number;
}

export interface StatusEntry {
  id: string;
  workspace_id: string;
  name: string;
  position: number;
}

export interface ActivityListInput {
  workspace_id?: string;
  limit?: number;
}
export type ActivityListOutput = ActivityItem[];

export interface AiApplyOrganizeInput {
  id: string;
  title?: string;
  year?: number;
  tag_names?: string[];
  region?: string;
  lat?: number;
  lng?: number;
  source_urls?: string[];
  folder_id?: string;
  clear_fields?: string[];
  remove_source_urls?: string[];
}
export interface AiApplyOrganizeOutput {
  applied: string[];
}

export interface AiApplyPlanInput {
  workspace_id: string;
  scope: AiPlanScope;
  execution_id: string;
  actions: AiPlanAction[];
}
export type AiApplyPlanOutput = AiPlanActionResult[];

export interface AiCallAnnotateInput {
  request_id: string;
  discard_reason: 'wrong' | 'too_long' | 'bad_format' | 'other';
}
export interface AiCallAnnotateOutput {
  ok: boolean;
}

export interface AiCallsActiveInput {}
export interface AiCallsActiveOutput {
  items: CallLogEntry[];
}

export interface AiCallsRecentInput {
  limit?: number;
}
export interface AiCallsRecentOutput {
  items: CallLogEntry[];
}

export interface AiCallsSummaryInput {
  days: number;
}
export type AiCallsSummaryOutput = CallsSummary;

export interface AiCancelCallInput {
  id?: string;
  request_id?: string;
}
export interface AiCancelCallOutput {
  cancelled: boolean;
  count: number;
}

export interface AiCleanupTextInput {
  text: string;
  provider: 'ollama' | 'openai' | 'claude' | 'gemini' | 'minimax' | 'openrouter';
  endpoint?: string;
  api_key?: string;
  model?: string;
  request_id?: string;
}
export interface AiCleanupTextOutput {
  cleaned: string;
}

export interface AiGenerateFromPromptInput {
  prompt: string;
  context_text?: string;
  provider: 'ollama' | 'openai' | 'claude' | 'gemini' | 'minimax' | 'openrouter';
  endpoint?: string;
  api_key?: string;
  model?: string;
  request_id?: string;
  preset_id?: string;
  purpose?: 'transform' | 'generate' | 'json';
}
export interface AiGenerateFromPromptOutput {
  generated: string;
}

export interface AiGetHistoryInput {
  workspace_id: string;
  limit?: number;
}
export interface AiGetHistoryOutput {
  items: AiHistoryItem[];
}

export interface AiGetUsageInput {
  workspace_id?: string;
  since?: string;
}
export interface AiGetUsageOutput {
  rows: AiUsageRow[];
}

export interface AiOpenrouterConnectInput {}
export interface AiOpenrouterConnectOutput {
  api_key: string;
}

export interface AiOrganizeNoteInput {
  id: string;
  fields?: string[];
  provider: 'ollama' | 'openai' | 'claude' | 'gemini' | 'minimax' | 'openrouter';
  endpoint?: string;
  api_key?: string;
  model?: string;
  custom_prompt?: string;
  origin?: string;
  request_id?: string;
}
export interface AiOrganizeNoteOutput {
  title?: string;
  year?: number;
  tag_names?: string[];
  region?: string;
  folder_id?: string;
  folder_name?: string;
  lat?: number;
  lng?: number;
  source_urls?: string[];
  confidence: number;
}

export interface AiTestConnectionInput {
  provider: 'ollama' | 'openai' | 'claude' | 'gemini' | 'minimax' | 'openrouter';
  endpoint?: string;
  api_key?: string;
}
export interface AiTestConnectionOutput {
  ok: boolean;
  latency_ms: number;
  models?: string[];
}

export interface AiTestConnectionBeforeEnableInput {
  provider: 'ollama' | 'openai' | 'claude' | 'gemini' | 'minimax' | 'openrouter';
  endpoint?: string;
  api_key?: string;
}
export interface AiTestConnectionBeforeEnableOutput {
  ok: boolean;
  latency_ms: number;
  models?: string[];
}

export interface AiTranslateTextInput {
  text: string;
  target_lang: 'fr' | 'en' | 'ko';
  provider: 'ollama' | 'openai' | 'claude' | 'gemini' | 'minimax' | 'openrouter';
  endpoint?: string;
  api_key?: string;
  model?: string;
  request_id?: string;
}
export interface AiTranslateTextOutput {
  translated: string;
}

export interface AttachmentAddBytesInput {
  note_id: string;
  name: string;
  data_base64: string;
}
export type AttachmentAddBytesOutput = Attachment;

export interface AttachmentAddChartInput {
  note_id: string;
  section_id: string;
  chart_id: string;
  name: string;
}
export type AttachmentAddChartOutput = Attachment;

export interface AttachmentAddFileInput {
  note_id: string;
  file_path: string;
  mode?: string;
}
export type AttachmentAddFileOutput = Attachment;

export interface AttachmentAddFootnoteInput {
  note_id: string;
  text: string;
  anchor_text?: string;
}
export type AttachmentAddFootnoteOutput = Attachment;

export interface AttachmentAddInternalInput {
  note_id: string;
  target_note_id: string;
  name: string;
}
export type AttachmentAddInternalOutput = Attachment;

export interface AttachmentAddLinkInput {
  note_id: string;
  name: string;
  url: string;
}
export type AttachmentAddLinkOutput = Attachment;

export interface AttachmentFetchReaderInput {
  id: string;
}
export interface AttachmentFetchReaderOutput {
  title: string | null;
  text: string;
  truncated: boolean;
}

export interface AttachmentOpenInput {
  id: string;
}
export interface AttachmentOpenOutput {
  ok: boolean;
}

export interface AttachmentQueryInput {
  kinds?: string[];
  query?: string;
  offset?: number;
  limit?: number;
  workspace_id?: string;
}
export interface AttachmentQueryOutput {
  items: AttachmentQueryItem[];
}

export interface AttachmentReadTextInput {
  id: string;
}
export interface AttachmentReadTextOutput {
  text: string;
  truncated: boolean;
}

export interface AttachmentRemoveInput {
  id: string;
}
export interface AttachmentRemoveOutput {
  deleted: boolean;
}

export interface AttachmentRenameInput {
  id: string;
  name: string;
}
export type AttachmentRenameOutput = Attachment;

export interface AttachmentRevealInput {
  id: string;
}
export interface AttachmentRevealOutput {
  ok: boolean;
}

export interface AttachmentThumbsInput {
  note_id: string;
}
export interface AttachmentThumbsOutput {
  thumbs: AttachmentThumb[];
}

export interface AttachmentThumbsForIdsInput {
  ids: string[];
}
export interface AttachmentThumbsForIdsOutput {
  thumbs: AttachmentThumb[];
}

export interface AttachmentTranscriptMarkInsertedInput {
  attachment_id: string;
}
export interface AttachmentTranscriptMarkInsertedOutput {
  ok: boolean;
}

export interface AttachmentsBaseDirInput {}
export interface AttachmentsBaseDirOutput {
  base: string;
}

export interface AudioTranscribeInput {
  note_id: string;
  attachment_id: string;
}
export interface AudioTranscribeOutput {
  text: string;
}

export interface BackupAutoRunInput {}
export interface BackupAutoRunOutput {
  backup_path: string;
  size_bytes: number;
  excluded_reference_count: number;
}

export interface BackupAutoStatusInput {}
export interface BackupAutoStatusOutput {
  last_backup_at: string | null;
  interval: string;
  keep: number;
  last_error: string | null;
}

export interface BackupCreateInput {
  dest_path: string;
}
export interface BackupCreateOutput {
  backup_path: string;
  size_bytes: number;
  excluded_reference_count: number;
}

export interface BackupRestoreInput {
  zip_path: string;
  confirm: 'RESTORE';
}
export interface BackupRestoreOutput {
  backup_path: string;
  note_count: number;
}

export interface BriefingBlockCreateInput {
  workspace_id?: string;
  day: string;
  start_time: string;
  end_time: string;
  title: string;
}
export interface BriefingBlockCreateOutput {
  note_id: string;
  date_id: string;
}

export interface BriefingNoteQuoteInput {
  workspace_id?: string;
  exclude_note_id?: string;
}
export interface BriefingNoteQuoteOutput {
  quote: BriefingNoteQuote | null;
}

export interface BriefingRecentCollectedInput {
  workspace_id?: string;
  since?: string;
  limit?: number;
}
export interface BriefingRecentCollectedOutput {
  items: CollectedNote[];
  new_count: number;
}

export interface BriefingRecentNotesInput {
  workspace_id?: string;
  limit?: number;
}
export interface BriefingRecentNotesOutput {
  items: RecentWorkNote[];
}

export interface CalendarFetchIcsInput {
  url: string;
}
export interface CalendarFetchIcsOutput {
  text: string;
}

export interface CalendarMarkCreateInput {
  workspace_id?: string;
  title: string;
  year?: number;
  month: number;
  day: number;
  repeat: string;
  lunar?: boolean;
  day_off?: boolean;
  color_hue?: number;
}
export type CalendarMarkCreateOutput = CalendarMark;

export interface CalendarMarkDeleteInput {
  id: string;
}
export interface CalendarMarkDeleteOutput {
  ok: boolean;
}

export interface CalendarMarkSetHiddenInput {
  workspace_id?: string;
  source: string;
  iso_day: string;
  hidden: boolean;
}
export interface CalendarMarkSetHiddenOutput {
  ok: boolean;
}

export interface CalendarMarkUpdateInput {
  id: string;
  title: string;
  year?: number;
  month: number;
  day: number;
  repeat: string;
  lunar?: boolean;
  day_off?: boolean;
  color_hue?: number;
}
export type CalendarMarkUpdateOutput = CalendarMark;

export interface CalendarMarksListInput {
  workspace_id?: string;
}
export interface CalendarMarksListOutput {
  sources: CalendarSource[];
  marks: CalendarMark[];
  hides: CalendarMarkHide[];
}

export interface CalendarSourceDeleteInput {
  id: string;
}
export interface CalendarSourceDeleteOutput {
  ok: boolean;
}

export interface CalendarSourceSaveInput {
  workspace_id?: string;
  source_id?: string;
  name: string;
  url?: string;
  marks: CalendarMarkImport[];
}
export interface CalendarSourceSaveOutput {
  source: CalendarSource;
  skipped: number;
}

export interface CalendarSourceUpdateInput {
  id: string;
  name?: string;
  enabled?: boolean;
}
export type CalendarSourceUpdateOutput = CalendarSource;

export interface CaptureSetLedgerEnabledInput {
  enabled: boolean;
}
export type CaptureSetLedgerEnabledOutput = CaptureStatus;

export interface CaptureStatusInput {}
export type CaptureStatusOutput = CaptureStatus;

export interface CollectDetectChatSessionsInput {}
export interface CollectDetectChatSessionsOutput {
  sessions: DetectedChatSession[];
}

export interface CollectDetectLocalInput {
  workspace_id?: string;
}
export interface CollectDetectLocalOutput {
  candidates: LocalCandidate[];
}

export interface CollectGetStatsInput {
  workspace_id?: string;
  since?: string;
}
export interface CollectGetStatsOutput {
  per_action: CollectActionStat[];
  total_today: number;
  total_since: number;
}

export interface CollectImportLocalInput {
  workspace_id?: string;
  key: string;
}
export type CollectImportLocalOutput = CollectSource;

export interface CollectResolveYoutubeChannelInput {
  url: string;
}
export interface CollectResolveYoutubeChannelOutput {
  feed_url: string;
}

export interface CollectSourceAddNlInput {
  workspace_id?: string;
  input: string;
}
export type CollectSourceAddNlOutput = CollectSource;

export interface CollectSourceCreateInput {
  workspace_id?: string;
  kind: string;
  name: string;
  config: string;
  dry_run?: boolean;
  target_folder_id?: string;
  post_process?: string;
  post_process_model?: string;
  interval_minutes?: number;
  show_in_briefing?: boolean;
}
export type CollectSourceCreateOutput = CollectSource;

export interface CollectSourceDeleteInput {
  id: string;
}
export interface CollectSourceDeleteOutput {
  ok: boolean;
}

export interface CollectSourceDryRunInput {
  id: string;
}
export interface CollectSourceDryRunOutput { ok: boolean, items: DryRunItem[], error: string | null }

export interface CollectSourceListInput {
  workspace_id?: string;
}
export interface CollectSourceListOutput {
  sources: CollectSource[];
}

export interface CollectSourceRunNowInput {
  id: string;
}
export interface CollectSourceRunNowOutput { ok: boolean, added: number, error: string | null }

export interface CollectSourceSetEnabledInput {
  id: string;
  enabled: boolean;
}
export interface CollectSourceSetEnabledOutput {
  ok: boolean;
}

export interface CollectSourceUpdateInput {
  id: string;
  name?: string;
  config?: string;
  dry_run?: boolean;
  target_folder_id?: string;
  post_process?: string;
  post_process_model?: string;
  interval_minutes?: number;
  show_in_briefing?: boolean;
}
export type CollectSourceUpdateOutput = CollectSource;

export interface CollectYtdlpInstallInput {}
export interface CollectYtdlpInstallOutput {
  ok: boolean;
}

export interface CollectYtdlpStatusInput {}
export interface CollectYtdlpStatusOutput {
  installed: boolean;
}

export interface DashboardBoardInput {
  workspace_id: string;
}
export type DashboardBoardOutput = BoardResult;

export interface DashboardCalendarInput {
  workspace_id: string;
  year: number;
  month: number;
}
export type DashboardCalendarOutput = CalendarResult;

export interface DashboardGraphInput {
  workspace_id: string;
  limit?: number;
}
export type DashboardGraphOutput = GraphResult;

export interface DashboardTimelineInput {
  workspace_id: string;
  from_year: number;
  to_year: number;
}
export type DashboardTimelineOutput = TimelineResult;

export interface DataDirOpenInput {}
export interface DataDirOpenOutput {
  ok: boolean;
}

export interface DataLocationApplyInput {
  path: string;
}
export interface DataLocationApplyOutput {
  split: boolean;
  restart_required: boolean;
}

export interface DataLocationGetInput {}
export interface DataLocationGetOutput {
  root: string;
  attachments_dir: string;
  backups_dir: string;
  is_default: boolean;
  split: boolean;
}

export interface DataLocationInspectInput {
  path: string;
}
export interface DataLocationInspectOutput {
  path: string;
  cloud_provider: string | null;
  writable: boolean;
  has_existing_data: boolean;
  free_bytes: number | null;
  total_bytes: number | null;
  current_data_bytes: number;
}

export interface DbResetInput {
  confirm: 'RESET';
}
export interface DbResetOutput {
  backup_path: string;
}

export interface DbStatsInput {}
export interface DbStatsOutput {
  note_count: number;
  attachment_count: number;
  distinct_note_days: number;
  db_size_bytes: number;
  attachments_size_bytes: number;
  image_size_bytes: number;
  disk_free_bytes: number | null;
}

export interface DiagRecentInput {
  limit?: number;
}
export interface DiagRecentOutput {
  items: DiagEntry[];
}

export interface DiagRecordInput {
  source: string;
  feature: string;
  code: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}
export interface DiagRecordOutput {
  ok: boolean;
}

export interface DiagStatusInput {}
export interface DiagStatusOutput {
  workers: DiagWorkerStatus[];
  log_dir: string;
}

export interface DiagTakeNoticesInput {}
export interface DiagTakeNoticesOutput {
  items: DiagNotice[];
}

export interface DocImportHtmlInput {
  note_id: string;
  file_path: string;
}
export interface DocImportHtmlOutput {
  name: string;
  html: string;
  image_count: number;
  dropped: DocImportDropped[];
  attachment_ids: string[];
}

export interface ExportAllInput {
  dest_dir: string;
}
export interface ExportAllOutput {
  note_count: number;
  bundle_path: string;
}

export interface ExportDiagramPngInput {
  dest_path: string;
  data_base64: string;
}
export interface ExportDiagramPngOutput {
  written_path: string;
}

export interface ExportDocxInput {
  note_id: string;
  dest_path: string;
  title: string;
  sections: DocExportSection[];
  paper: 'a4-portrait' | 'a4-landscape' | 'b5-portrait' | 'b5-landscape' | 'letter-portrait' | 'letter-landscape';
  margin: 'narrow' | 'normal' | 'wide';
}
export interface ExportDocxOutput {
  written_path: string;
  image_count: number;
  skipped_images: number;
}

export interface ExportFolderInput {
  id: string;
  dest_path: string;
}
export interface ExportFolderOutput {
  exported_count: number;
  skipped_count: number;
  written_dir: string;
}

export interface ExportFolderBundleInput {
  id: string;
  dest_dir: string;
}
export interface ExportFolderBundleOutput {
  note_count: number;
  bundle_path: string;
}

export interface ExportHtmlInput {
  note_id: string;
  dest_path: string;
  html: string;
}
export interface ExportHtmlOutput {
  written_path: string;
  image_count: number;
  skipped_images: number;
}

export interface ExportHtmlInlineInput {
  note_id: string;
  html: string;
}
export interface ExportHtmlInlineOutput {
  html: string;
  image_count: number;
  skipped_images: number;
}

export interface ExportHwpxInput {
  note_id: string;
  dest_path: string;
  title: string;
  sections: DocExportSection[];
  paper: 'a4-portrait' | 'a4-landscape' | 'b5-portrait' | 'b5-landscape' | 'letter-portrait' | 'letter-landscape';
  margin: 'narrow' | 'normal' | 'wide';
}
export interface ExportHwpxOutput {
  written_path: string;
  image_count: number;
  skipped_images: number;
}

export interface ExportNoteInput {
  id: string;
  dest_path: string;
}
export interface ExportNoteOutput {
  written_path: string;
  exported_at: string;
}

export interface ExportOpenInput {
  path: string;
  reveal: boolean;
}
export interface ExportOpenOutput {}

export interface ExportSectionMdInput {
  id: string;
  dest_path: string;
}
export interface ExportSectionMdOutput {
  written_path: string;
}

export interface ExportSheetCsvInput {
  dest_path: string;
  csv: string;
}
export interface ExportSheetCsvOutput {
  written_path: string;
}

export interface ExportWorkspaceBundleInput {
  id: string;
  dest_dir: string;
}
export interface ExportWorkspaceBundleOutput {
  note_count: number;
  bundle_path: string;
}

export interface FolderCreateInput {
  name: string;
  workspace_id?: string;
  color_hue?: number | null;
  icon?: string | null;
  rules?: string | null;
}
export type FolderCreateOutput = Folder;

export interface FolderFilesInput {
  id: string;
}
export interface FolderFilesOutput {
  notes: NoteFiles[];
  total_bytes: number;
}

export interface FolderListInput {
  workspace_id?: string;
}
export interface FolderListOutput {
  folders: Folder[];
  notes_by_folder: Record<string, NoteSummary[]>;
}

export interface FolderListMetaInput {
  workspace_id?: string;
}
export interface FolderListMetaOutput {
  folders: Folder[];
  notes_by_folder: Record<string, NoteSummary[]>;
}

export interface FolderRenameInput {
  id: string;
  name: string;
}
export type FolderRenameOutput = Folder;

export interface FolderSetColorInput {
  id: string;
  color_hue: number | null;
}
export type FolderSetColorOutput = Folder;

export interface FolderSetExclusionsInput {
  id: string;
  search_excluded: boolean;
  ai_excluded: boolean;
}
export type FolderSetExclusionsOutput = Folder;

export interface FolderSetIconInput {
  id: string;
  icon: string | null;
}
export type FolderSetIconOutput = Folder;

export interface FolderSetOpenInput {
  id: string;
  is_open: boolean;
}
export interface FolderSetOpenOutput {
  ok: boolean;
}

export interface FolderSetRulesInput {
  id: string;
  rules: string | null;
}
export type FolderSetRulesOutput = Folder;

export interface GeoTimezoneInput {
  lat: number;
  lng: number;
}
export interface GeoTimezoneOutput {
  time_zone: string | null;
}

export interface GeocodeReverseInput {
  lat: number;
  lng: number;
  lang?: string;
}
export interface GeocodeReverseOutput {
  label: string | null;
}

export interface GeocodeSearchInput {
  query: string;
  lang?: string;
}
export interface GeocodeSearchOutput {
  results: GeocodeResult[];
}

export interface GraphSuggestionAcceptInput {
  id: string;
}
export interface GraphSuggestionAcceptOutput {
  ok: boolean;
}

export interface GraphSuggestionDismissInput {
  id: string;
}
export interface GraphSuggestionDismissOutput {
  ok: boolean;
}

export interface HabitCheckInput {
  habit_id: string;
  day: string;
  done: boolean;
}
export interface HabitCheckOutput {
  habit_id: string;
  day: string;
  done: boolean;
}

export interface HabitCreateInput {
  workspace_id?: string;
  title: string;
  icon?: string;
  hue?: number;
  weekday_mask?: number;
  time_of_day?: string;
}
export type HabitCreateOutput = Habit;

export interface HabitDeleteInput {
  id: string;
}
export interface HabitDeleteOutput {
  ok: boolean;
}

export interface HabitHistoryInput {
  workspace_id?: string;
  from: string;
  to: string;
}
export type HabitHistoryOutput = HabitHistory;

export interface HabitListInput {
  workspace_id?: string;
}
export interface HabitListOutput {
  habits: Habit[];
}

export interface HabitReorderInput {
  workspace_id?: string;
  ids: string[];
}
export interface HabitReorderOutput {
  ok: boolean;
}

export interface HabitUpdateInput {
  id: string;
  title?: string;
  icon?: string;
  hue?: number;
  weekday_mask?: number;
  time_of_day?: string;
  archived?: boolean;
}
export type HabitUpdateOutput = Habit;

export interface HabitWeekInput {
  workspace_id?: string;
  day: string;
  week_start?: string;
}
export type HabitWeekOutput = HabitWeek;

export interface ImportBundleInput {
  bundle_path: string;
  mode: 'merge' | 'replace' | 'add_notebook' | 'hash_merge';
  target_workspace_id?: string;
  update_existing?: boolean;
}
export interface ImportBundleOutput {
  imported_notes: number;
  skipped: number;
  backup_path?: string;
}

export interface LinkPreviewInput {
  workspace_id?: string;
  url: string;
}
export interface LinkPreviewOutput {
  ok: boolean;
  title: string;
  summary: string;
  target_note_id?: string;
  target_note_title?: string;
}

export interface LinkSuggestInput {
  workspace_id?: string;
  note_id: string;
  url: string;
}
export interface LinkSuggestOutput {
  ok: boolean;
}

export interface MigrationImportEnexInput {
  folder_id: string;
  enex_path: string;
}
export interface MigrationImportEnexOutput {
  imported: number;
  skipped: number;
  note_ids: string[];
}

export interface MigrationImportMarkdownInput {
  folder_id: string;
  source_dir: string;
}
export interface MigrationImportMarkdownOutput {
  imported: number;
  skipped: number;
  note_ids: string[];
}

export interface MigrationImportNotionInput {
  folder_id: string;
  zip_path: string;
}
export interface MigrationImportNotionOutput {
  imported: number;
  skipped: number;
  note_ids: string[];
}

export interface NoteArchiveInput {
  id: string;
}
export interface NoteArchiveOutput {
  ok: boolean;
}

export interface NoteArchivedCountInput {
  workspace_id?: string;
}
export interface NoteArchivedCountOutput {
  count: number;
}

export interface NoteArchivedListInput {
  workspace_id?: string;
}
export type NoteArchivedListOutput = NoteSummary[];

export interface NoteCoverImageInput {
  note_id: string;
}
export type NoteCoverImageOutput = CoverImageResult;

export interface NoteCoverImagesInput {
  note_ids: string[];
}
export interface NoteCoverImagesOutput {
  items: CoverImageResult[];
}

export interface NoteCreateInput {
  folder_id: string;
  title?: string;
  year?: number;
  month?: number;
  day?: number;
}
export type NoteCreateOutput = NoteDetail;

export interface NoteDateAddInput {
  note_id: string;
  year: number;
  month?: number;
  day?: number;
  end_year?: number;
  end_month?: number;
  end_day?: number;
  start_time?: string;
  end_time?: string;
  remind?: boolean;
  remind_offset_min?: number;
  rrule?: string;
  label?: string;
}
export interface NoteDateAddOutput {
  id: string;
}

export interface NoteDateMakePrimaryInput {
  id: string;
}
export interface NoteDateMakePrimaryOutput {
  ok: boolean;
}

export interface NoteDateRemoveInput {
  id: string;
}
export interface NoteDateRemoveOutput {
  ok: boolean;
}

export interface NoteDateReorderInput {
  note_id: string;
  ordered_ids: string[];
}
export interface NoteDateReorderOutput {
  ok: boolean;
}

export interface NoteDateUpdateInput {
  id: string;
  year: number;
  month: number | null;
  day: number | null;
  end_year: number | null;
  end_month: number | null;
  end_day: number | null;
  start_time: string | null;
  end_time: string | null;
  remind: boolean;
  remind_offset_min: number | null;
  rrule: string | null;
  label: string | null;
}
export type NoteDateUpdateOutput = NoteDate;

export interface NoteDatesListInput {
  note_id: string;
}
export interface NoteDatesListOutput {
  dates: NoteDate[];
}

export interface NoteDeleteInput {
  id: string;
}
export interface NoteDeleteOutput {
  deleted: boolean;
}

export interface NoteGetInput {
  id: string;
}
export type NoteGetOutput = NoteDetail;

export interface NoteGetManyInput {
  ids: string[];
}
export interface NoteGetManyOutput {
  notes: NoteDetail[];
}

export interface NotePurgeInput {
  id: string;
}
export interface NotePurgeOutput {
  deleted: boolean;
}

export interface NoteQueryInput {
  workspace_id?: string;
  folder_ids?: string[];
  year_from?: number;
  year_to?: number;
  updated_from?: string;
  updated_to?: string;
  created_from?: string;
  created_to?: string;
  favorites_only?: boolean;
  include_archived?: boolean;
  tags?: string[];
  tag_mode?: 'or' | 'and';
  region?: unknown;
  statuses?: string[];
  coords?: unknown;
  query?: string;
  sort?: 'year_asc' | 'year_desc' | 'updated_desc' | 'created_desc' | 'title_asc';
  offset?: number;
  limit?: number;
}
export interface NoteQueryOutput {
  notes: NoteSummary[];
  total: number;
}

export interface NoteRecordHistogramInput {
  workspace_id?: string;
  axis?: 'updated' | 'created' | 'union';
  from: string;
  to: string;
}
export interface NoteRecordHistogramOutput {
  counts: unknown;
}

export interface NoteRegionAddInput {
  note_id: string;
  name: string;
  lat: number;
  lng: number;
  position: number;
}
export interface NoteRegionAddOutput {
  id: string;
}

export interface NoteRegionMoveInput {
  id: string;
  lat: number;
  lng: number;
}
export interface NoteRegionMoveOutput {
  ok: boolean;
}

export interface NoteRegionRemoveInput {
  id: string;
}
export interface NoteRegionRemoveOutput {
  ok: boolean;
}

export interface NoteRegionReorderInput {
  note_id: string;
  ordered_ids: string[];
}
export interface NoteRegionReorderOutput {
  ok: boolean;
}

export interface NoteRegionsListInput {
  note_id: string;
}
export interface NoteRegionsListOutput {
  regions: NoteRegion[];
}

export interface NoteRelatedInput {
  id: string;
  limit?: number;
}
export interface NoteRelatedOutput {
  notes: NoteSummary[];
}

export interface NoteRelatedExcludeInput {
  id_1: string;
  id_2: string;
}
export interface NoteRelatedExcludeOutput {
  ok: boolean;
}

export interface NoteRelatedHiddenCountInput {
  id: string;
}
export interface NoteRelatedHiddenCountOutput {
  count: number;
}

export interface NoteRelatedRestoreInput {
  id: string;
}
export interface NoteRelatedRestoreOutput {
  count: number;
}

export interface NoteRestoreInput {
  id: string;
}
export interface NoteRestoreOutput {
  ok: boolean;
}

export interface NoteSetIconInput {
  id: string;
  icon: string | null;
}
export type NoteSetIconOutput = NoteSummary;

export interface NoteSetLocationInput {
  id: string;
  lat: number | null;
  lng: number | null;
}
export type NoteSetLocationOutput = NoteSummary;

export interface NoteSetRegionInput {
  id: string;
  region: string | null;
}
export type NoteSetRegionOutput = NoteSummary;

export interface NoteSetStatusInput {
  id: string;
  status: string | null;
}
export type NoteSetStatusOutput = NoteSummary;

export interface NoteSetTagsInput {
  id: string;
  tag_names: string[];
}
export interface NoteSetTagsOutput {
  tag_names: string[];
}

export interface NoteSnapshotCaptureInput {
  note_id: string;
}
export type NoteSnapshotCaptureOutput = SnapshotMeta;

export interface NoteSnapshotGetInput {
  id: string;
}
export type NoteSnapshotGetOutput = SnapshotDetail;

export interface NoteSnapshotListInput {
  note_id: string;
}
export type NoteSnapshotListOutput = SnapshotListItem[];

export interface NoteSnapshotRestoreInput {
  id: string;
}
export type NoteSnapshotRestoreOutput = RestoreResult;

export interface NoteSummariesMapInput {
  ids: string[];
}
export interface NoteSummariesMapOutput {
  notes: Record<string, NoteSummary>;
}

export interface NoteTagsIndexInput {
  workspace_id?: string;
}
export interface NoteTagsIndexOutput {
  tags_by_note: Record<string, string[]>;
}

export interface NoteToggleContentLockInput {
  id: string;
}
export interface NoteToggleContentLockOutput {
  content_locked: boolean;
}

export interface NoteToggleFavoriteInput {
  id: string;
}
export interface NoteToggleFavoriteOutput {
  is_favorite: boolean;
}

export interface NoteTrashCountInput {
  workspace_id?: string;
}
export interface NoteTrashCountOutput {
  count: number;
}

export interface NoteTrashListInput {
  workspace_id?: string;
}
export type NoteTrashListOutput = NoteSummary[];

export interface NoteUnarchiveInput {
  id: string;
}
export interface NoteUnarchiveOutput {
  ok: boolean;
}

export interface NoteUpdateInput {
  id: string;
  title?: string;
  year?: number;
  folder_id?: string;
  remind?: boolean;
}
export type NoteUpdateOutput = NoteSummary;

export interface NoteYearHistogramInput {
  workspace_id?: string;
}
export interface NoteYearHistogramOutput {
  counts: unknown;
}

export interface NotifySendInput {
  title: string;
  body: string;
}
export interface NotifySendOutput {
  ok: boolean;
}

export interface PetAssetClearInput {
  mood: string;
}
export interface PetAssetClearOutput {
  ok: boolean;
}

export interface PetAssetPreviewInput {
  path: string;
}
export interface PetAssetPreviewOutput {
  kind: string;
  data_url: string;
}

export interface PetAssetSetInput {
  mood: string;
  path: string;
  frames?: number;
  cycle_ms?: number;
}
export interface PetAssetSetOutput {
  ok: boolean;
}

export interface PetAssetsListInput {}
export interface PetAssetsListOutput {
  items: PetAsset[];
}

export interface PetBubbleClipInput {
  payload: string;
}
export interface PetBubbleClipOutput {
  ok: boolean;
}

export interface PetBubbleCloseInput {}
export interface PetBubbleCloseOutput {
  ok: boolean;
}

export interface PetBubbleNoticeInput {
  text: string;
  note_id?: string;
}
export interface PetBubbleNoticeOutput {
  shown: boolean;
}

export interface PetBubbleResizeInput {
  height: number;
}
export interface PetBubbleResizeOutput {
  ok: boolean;
}

export interface PetBubbleStateInput {}
export interface PetBubbleStateOutput {
  mode: string;
  text: string;
  note_id?: string;
}

export interface PetBubbleToggleInput {}
export interface PetBubbleToggleOutput {
  open: boolean;
}

export interface PetChatInput {
  message: string;
  active_note_id?: string;
  active_note_title?: string;
  active_note_excerpt?: string;
  image_base64?: string;
  image_mime?: string;
  display_text?: string;
  allow_write?: boolean;
  show_evidence?: boolean;
  fail_text?: string;
}
export interface PetChatOutput {
  reply: string;
  action: 'answer' | 'create_note' | 'create_section' | 'search' | 'propose_plan';
  note_id?: string;
  note_title?: string;
  section_title?: string;
  section_body?: string;
  hits: PetSearchHit[];
  plan_kind?: 'fill_note' | 'rename_plan' | 'prune_plan';
  plan_id?: string;
  vision_status?: 'used' | 'fallback_text';
  user_created_at?: string;
  assistant_created_at?: string;
}

export interface PetChatClearInput {}
export interface PetChatClearOutput {
  cleared: number;
}

export interface PetChatDeleteInput {
  created_at: string;
  role: string;
}
export interface PetChatDeleteOutput {
  deleted: number;
  messages: PetMessage[];
}

export interface PetChatHistoryInput {
  limit?: number;
}
export interface PetChatHistoryOutput {
  messages: PetMessage[];
}

export interface PetChatReadAttachInput {
  path: string;
}
export interface PetChatReadAttachOutput {
  kind: string;
  name: string;
  mime?: string;
  base64?: string;
  excerpt?: string;
}

export interface PetChatRewindInput {
  created_at: string;
}
export interface PetChatRewindOutput {
  truncated: number;
  messages: PetMessage[];
}

export interface PetCloseInput {}
export interface PetCloseOutput {
  closed: boolean;
}

export interface PetConversationSaveInput {
  messages: PetMessage[];
  title?: string;
}
export interface PetConversationSaveOutput {
  note_id: string;
  title: string;
}

export interface PetMenuPopupInput {}
export interface PetMenuPopupOutput {
  ok: boolean;
}

export interface PetNoteCreateInput {
  text: string;
  title?: string;
}
export interface PetNoteCreateOutput {
  note_id: string;
  title: string;
}

export interface PetNotificationsInput {}
export interface PetNotificationsOutput {
  items: PetNotification[];
}

export interface PetOpenMainInput {
  note_id?: string;
}
export interface PetOpenMainOutput {
  ok: boolean;
}

export interface PetPackageAssetInput {
  id?: string;
  preview?: boolean;
}
export interface PetPackageAssetOutput {
  data_url: string;
}

export interface PetPackageInstallInput {
  path: string;
}
export interface PetPackageInstallOutput {
  ok: boolean;
}

export interface PetPackageInstallUrlInput {
  url: string;
}
export interface PetPackageInstallUrlOutput {
  ok: boolean;
}

export interface PetPackageRemoveInput {
  id: string;
}
export interface PetPackageRemoveOutput {
  ok: boolean;
}

export interface PetPackageSelectInput {
  id: string;
}
export interface PetPackageSelectOutput {
  ok: boolean;
}

export interface PetPackagesImportCodexInput {}
export interface PetPackagesImportCodexOutput {
  installed: string[];
  failed: PetInstallFailure[];
}

export interface PetPackagesListInput {}
export interface PetPackagesListOutput {
  items: PetPackage[];
}

export interface PetPositionResetInput {}
export interface PetPositionResetOutput {
  x: number;
  y: number;
}

export interface PetScreenshotCaptureInput {}
export interface PetScreenshotCaptureOutput {
  title: string;
  name: string;
  data_base64: string;
  summary: string;
  ai_summary_status: 'generated' | 'disabled' | 'unsupported_or_failed' | 'timeout';
}

export interface PetSessionListInput {}
export interface PetSessionListOutput {
  sessions: PetSessionSummary[];
}

export interface PetSessionNewInput {}
export interface PetSessionNewOutput {
  session_id: string;
  archived_id?: string;
  messages: PetMessage[];
}

export interface PetSessionOpenInput {
  session_id: string;
}
export interface PetSessionOpenOutput {
  session_id: string;
  messages: PetMessage[];
}

export interface PetSetEnabledInput {
  enabled: boolean;
}
export interface PetSetEnabledOutput {
  ok: boolean;
}

export interface PetSetPositionInput {
  x: number;
  y: number;
}
export interface PetSetPositionOutput {
  ok: boolean;
}

export interface PetSetVisibleInput {
  visible: boolean;
}
export interface PetSetVisibleOutput {
  ok: boolean;
}

export interface PetThemeInput {}
export interface PetThemeOutput {
  theme: string;
  accent: string;
  font_scale: number;
  capture_screenshot: boolean;
  surface_style: string;
  sheet_alpha: number;
  ai_enabled: boolean;
  pet_dblclick_action: string;
  chat_write_enabled: boolean;
}

export interface PhrasePackSaveInput {
  name: string;
  items: { text: string, source?: string }[];
}
export interface PhrasePackSaveOutput {
  id: string;
  file_name: string;
}

export interface PhrasePacksListInput {}
export interface PhrasePacksListOutput {
  packs: { id: string, name: string, items: { text: string, source?: string }[] }[];
}

export interface RegionRegistryInput {
  workspace_id?: string;
}
export interface RegionRegistryOutput {
  entries: RegionRegistryEntry[];
}

export interface RoutineHistoryInput {
  workspace_id: string;
  from: string;
  to: string;
}
export type RoutineHistoryOutput = RoutineHistoryResult;

export interface RoutineTodayInput {
  workspace_id: string;
}
export type RoutineTodayOutput = RoutineTodayResult;

export interface RoutineToggleInput {
  note_id: string;
  occur_on: string;
  done: boolean;
}
export type RoutineToggleOutput = RoutineToggleResult;

export interface ScheduleTodayInput {
  workspace_id: string;
}
export type ScheduleTodayOutput = ScheduleTodayResult;

export interface SearchNotesInput {
  query: string;
  year_from?: number;
  year_to?: number;
  workspace_id?: string;
  limit?: number;
}
export interface SearchNotesOutput {
  results: NoteSummary[];
  total: number;
}

export interface SectionCreateInput {
  note_id: string;
  name?: string;
}
export type SectionCreateOutput = Section;

export interface SectionCreateWithBodyInput {
  note_id: string;
  name?: string;
  body_md: string;
  kind?: 'text' | 'diagram' | 'sheet';
  ai_origin?: string;
}
export type SectionCreateWithBodyOutput = Section;

export interface SectionDeleteInput {
  id: string;
}
export interface SectionDeleteOutput {
  deleted: boolean;
}

export interface SectionImportFileInput {
  note_id: string;
  file_path: string;
}
export interface SectionImportFileOutput {
  sections: Section[];
  truncated: boolean;
}

export interface SectionImportScanInput {
  paths: string[];
}
export interface SectionImportScanOutput {
  files: string[];
  skipped: number;
}

export interface SectionMoveInput {
  id: string;
  target_note_id: string;
}
export interface SectionMoveOutput {
  ok: boolean;
}

export interface SectionPurgeInput {
  id: string;
}
export interface SectionPurgeOutput {
  deleted: boolean;
}

export interface SectionReorderInput {
  note_id: string;
  ordered_ids: string[];
}
export interface SectionReorderOutput {
  ok: boolean;
}

export interface SectionRestoreInput {
  id: string;
}
export interface SectionRestoreOutput {
  ok: boolean;
}

export interface SectionTrashListInput {
  workspace_id?: string;
}
export type SectionTrashListOutput = SectionTrashEntry[];

export interface SectionUpdateInput {
  id: string;
  name?: string;
  body_md?: string;
  ai_origin?: string;
  expected_updated_at?: string;
}
export interface SectionUpdateOutput {
  updated_at: string;
  section_updated_at: string;
}

export interface SectionWindowCloseInput {
  section_id: string;
}
export interface SectionWindowCloseOutput {
  closed: boolean;
}

export interface SectionWindowListInput {}
export interface SectionWindowListOutput {
  section_ids: string[];
}

export interface SectionWindowOpenInput {
  note_id: string;
  section_id: string;
  title: string;
  x?: number;
  y?: number;
}
export interface SectionWindowOpenOutput {
  opened: boolean;
}

export interface SettingsGetAllInput {}
export interface SettingsGetAllOutput {
  settings: Record<string, unknown>;
}

export interface SettingsSetInput {
  entries: Record<string, unknown>;
}
export interface SettingsSetOutput {
  ok: boolean;
}

export interface SheetSetCellsInput {
  section_id: string;
  cells: Record<string, unknown>;
}
export interface SheetSetCellsOutput {
  updated_at: string;
  section_updated_at: string;
}

export interface SlidePreviewRenderInput {
  attachment_id: string;
}
export interface SlidePreviewRenderOutput {
  pdf_path: string | null;
  reason: string | null;
}

export interface SourceAddFileInput {
  note_id: string;
  file_path: string;
  original_policy?: 'keep' | 'discard';
}
export type SourceAddFileOutput = Source;

export interface SourceAddTextInput {
  note_id: string;
  name: string;
  body: string;
}
export type SourceAddTextOutput = Source;

export interface SourceDeleteInput {
  id: string;
}
export interface SourceDeleteOutput {
  deleted: boolean;
}

export interface SourceRenameInput {
  id: string;
  name: string;
}
export type SourceRenameOutput = Source;

export interface SuggestionSetStatusInput {
  id: string;
  status: 'pending' | 'dismissed' | 'accepted';
}
export interface SuggestionSetStatusOutput {
  ok: boolean;
}

export interface SuggestionsListInput {
  workspace_id?: string;
  status?: 'pending' | 'dismissed' | 'accepted';
}
export interface SuggestionsListOutput {
  suggestions: Suggestion[];
}

export interface SyncRegenerateTokenInput {}
export type SyncRegenerateTokenOutput = SyncStatus;

export interface SyncSetEnabledInput {
  enabled: boolean;
}
export type SyncSetEnabledOutput = SyncStatus;

export interface SyncStatusInput {}
export type SyncStatusOutput = SyncStatus;

export interface TagColorsInput {
  workspace_id?: string;
}
export interface TagColorsOutput {
  colors: Record<string, number>;
}

export interface TagCountsInput {
  workspace_id?: string;
}
export interface TagCountsOutput {
  counts: Record<string, number>;
}

export interface TagDeleteInput {
  name: string;
}
export interface TagDeleteOutput {
  ok: boolean;
  affected: number;
}

export interface TagMergeInput {
  from: string[];
  to: string;
}
export interface TagMergeOutput {
  ok: boolean;
  affected: number;
}

export interface TagRenameInput {
  from: string;
  to: string;
}
export interface TagRenameOutput {
  ok: boolean;
  affected: number;
}

export interface TagSetColorInput {
  name: string;
  color_hue: number | null;
}
export interface TagSetColorOutput {
  ok: boolean;
}

export interface ThemeDefaultsInput {}
export interface ThemeDefaultsOutput {
  entries: Record<string, unknown>;
}

export interface ThemeExportInput {
  path: string;
}
export interface ThemeExportOutput {
  ok: boolean;
}

export interface ThemeReadInput {
  path: string;
}
export interface ThemeReadOutput {
  entries: Record<string, unknown>;
  skipped_unknown: number;
  source: string;
}

export interface TimelineRoutineCreateInput {
  workspace_id?: string;
  title: string;
  weekday_mask: number;
  start_time: string;
  end_time: string;
  color_hue?: number;
  skip_holidays?: boolean;
}
export type TimelineRoutineCreateOutput = TimelineRoutine;

export interface TimelineRoutineDeleteInput {
  id: string;
}
export interface TimelineRoutineDeleteOutput {
  ok: boolean;
}

export interface TimelineRoutineListInput {
  workspace_id?: string;
}
export interface TimelineRoutineListOutput {
  routines: TimelineRoutine[];
}

export interface TimelineRoutineUpdateInput {
  id: string;
  title?: string;
  weekday_mask?: number;
  start_time?: string;
  end_time?: string;
  color_hue?: number;
  skip_holidays?: boolean;
}
export type TimelineRoutineUpdateOutput = TimelineRoutine;

export interface TodoToggleInput {
  note_id: string;
  section_id: string;
  line_index: number;
  expected_checked: boolean;
}
export type TodoToggleOutput = TodoToggleResult;

export interface WeatherForecastInput {
  lat: number;
  lng: number;
}
export interface WeatherForecastOutput {
  entries: WeatherEntry[];
}

export interface WorkspaceBgBaseDirInput {}
export interface WorkspaceBgBaseDirOutput {
  base: string;
}

export interface WorkspaceClearBgImageInput {
  id: string;
}
export type WorkspaceClearBgImageOutput = Workspace;

export interface WorkspaceCreateInput {
  name: string;
  copy_settings_from?: string;
}
export type WorkspaceCreateOutput = Workspace;

export interface WorkspaceDeleteInput {
  id: string;
}
export interface WorkspaceDeleteOutput {
  deleted_note_count: number;
}

export interface WorkspaceDuplicateInput {
  id: string;
  name: string;
}
export type WorkspaceDuplicateOutput = Workspace;

export interface WorkspaceEraAddInput {
  workspace_id?: string;
  name: string;
  from_year: number;
  to_year: number;
}
export type WorkspaceEraAddOutput = EraEntry;

export interface WorkspaceEraListInput {
  workspace_id?: string;
}
export interface WorkspaceEraListOutput {
  eras: EraEntry[];
}

export interface WorkspaceEraRemoveInput {
  id: string;
}
export interface WorkspaceEraRemoveOutput {
  deleted: boolean;
}

export interface WorkspaceListInput {}
export interface WorkspaceListOutput {
  workspaces: Workspace[];
  active_id: string;
}

export interface WorkspaceRegionAddInput {
  workspace_id?: string;
  name: string;
}
export type WorkspaceRegionAddOutput = RegionEntry;

export interface WorkspaceRegionListInput {
  workspace_id?: string;
}
export interface WorkspaceRegionListOutput {
  regions: RegionEntry[];
}

export interface WorkspaceRegionRemoveInput {
  id: string;
}
export interface WorkspaceRegionRemoveOutput {
  deleted: boolean;
}

export interface WorkspaceRenameInput {
  id: string;
  name: string;
}
export type WorkspaceRenameOutput = Workspace;

export interface WorkspaceSetBgImageInput {
  id: string;
  file_path: string;
}
export type WorkspaceSetBgImageOutput = Workspace;

export interface WorkspaceSetIconInput {
  id: string;
  icon: string | null;
}
export type WorkspaceSetIconOutput = Workspace;

export interface WorkspaceStatusAddInput {
  workspace_id?: string;
  name: string;
}
export type WorkspaceStatusAddOutput = StatusEntry;

export interface WorkspaceStatusListInput {
  workspace_id?: string;
}
export interface WorkspaceStatusListOutput {
  statuses: StatusEntry[];
}

export interface WorkspaceStatusRemoveInput {
  id: string;
}
export interface WorkspaceStatusRemoveOutput {
  deleted: boolean;
}

export interface WorkspaceStatusRenameInput {
  id: string;
  name: string;
}
export type WorkspaceStatusRenameOutput = StatusEntry;

export type CommandName =
  | 'activity_list'
  | 'ai_apply_organize'
  | 'ai_apply_plan'
  | 'ai_call_annotate'
  | 'ai_calls_active'
  | 'ai_calls_recent'
  | 'ai_calls_summary'
  | 'ai_cancel_call'
  | 'ai_cleanup_text'
  | 'ai_generate_from_prompt'
  | 'ai_get_history'
  | 'ai_get_usage'
  | 'ai_openrouter_connect'
  | 'ai_organize_note'
  | 'ai_test_connection'
  | 'ai_test_connection_before_enable'
  | 'ai_translate_text'
  | 'attachment_add_bytes'
  | 'attachment_add_chart'
  | 'attachment_add_file'
  | 'attachment_add_footnote'
  | 'attachment_add_internal'
  | 'attachment_add_link'
  | 'attachment_fetch_reader'
  | 'attachment_open'
  | 'attachment_query'
  | 'attachment_read_text'
  | 'attachment_remove'
  | 'attachment_rename'
  | 'attachment_reveal'
  | 'attachment_thumbs'
  | 'attachment_thumbs_for_ids'
  | 'attachment_transcript_mark_inserted'
  | 'attachments_base_dir'
  | 'audio_transcribe'
  | 'backup_auto_run'
  | 'backup_auto_status'
  | 'backup_create'
  | 'backup_restore'
  | 'briefing_block_create'
  | 'briefing_note_quote'
  | 'briefing_recent_collected'
  | 'briefing_recent_notes'
  | 'calendar_fetch_ics'
  | 'calendar_mark_create'
  | 'calendar_mark_delete'
  | 'calendar_mark_set_hidden'
  | 'calendar_mark_update'
  | 'calendar_marks_list'
  | 'calendar_source_delete'
  | 'calendar_source_save'
  | 'calendar_source_update'
  | 'capture_set_ledger_enabled'
  | 'capture_status'
  | 'collect_detect_chat_sessions'
  | 'collect_detect_local'
  | 'collect_get_stats'
  | 'collect_import_local'
  | 'collect_resolve_youtube_channel'
  | 'collect_source_add_nl'
  | 'collect_source_create'
  | 'collect_source_delete'
  | 'collect_source_dry_run'
  | 'collect_source_list'
  | 'collect_source_run_now'
  | 'collect_source_set_enabled'
  | 'collect_source_update'
  | 'collect_ytdlp_install'
  | 'collect_ytdlp_status'
  | 'dashboard_board'
  | 'dashboard_calendar'
  | 'dashboard_graph'
  | 'dashboard_timeline'
  | 'data_dir_open'
  | 'data_location_apply'
  | 'data_location_get'
  | 'data_location_inspect'
  | 'db_reset'
  | 'db_stats'
  | 'diag_recent'
  | 'diag_record'
  | 'diag_status'
  | 'diag_take_notices'
  | 'doc_import_html'
  | 'export_all'
  | 'export_diagram_png'
  | 'export_docx'
  | 'export_folder'
  | 'export_folder_bundle'
  | 'export_html'
  | 'export_html_inline'
  | 'export_hwpx'
  | 'export_note'
  | 'export_open'
  | 'export_section_md'
  | 'export_sheet_csv'
  | 'export_workspace_bundle'
  | 'folder_create'
  | 'folder_files'
  | 'folder_list'
  | 'folder_list_meta'
  | 'folder_rename'
  | 'folder_set_color'
  | 'folder_set_exclusions'
  | 'folder_set_icon'
  | 'folder_set_open'
  | 'folder_set_rules'
  | 'geo_timezone'
  | 'geocode_reverse'
  | 'geocode_search'
  | 'graph_suggestion_accept'
  | 'graph_suggestion_dismiss'
  | 'habit_check'
  | 'habit_create'
  | 'habit_delete'
  | 'habit_history'
  | 'habit_list'
  | 'habit_reorder'
  | 'habit_update'
  | 'habit_week'
  | 'import_bundle'
  | 'link_preview'
  | 'link_suggest'
  | 'migration_import_enex'
  | 'migration_import_markdown'
  | 'migration_import_notion'
  | 'note_archive'
  | 'note_archived_count'
  | 'note_archived_list'
  | 'note_cover_image'
  | 'note_cover_images'
  | 'note_create'
  | 'note_date_add'
  | 'note_date_make_primary'
  | 'note_date_remove'
  | 'note_date_reorder'
  | 'note_date_update'
  | 'note_dates_list'
  | 'note_delete'
  | 'note_get'
  | 'note_get_many'
  | 'note_purge'
  | 'note_query'
  | 'note_record_histogram'
  | 'note_region_add'
  | 'note_region_move'
  | 'note_region_remove'
  | 'note_region_reorder'
  | 'note_regions_list'
  | 'note_related'
  | 'note_related_exclude'
  | 'note_related_hidden_count'
  | 'note_related_restore'
  | 'note_restore'
  | 'note_set_icon'
  | 'note_set_location'
  | 'note_set_region'
  | 'note_set_status'
  | 'note_set_tags'
  | 'note_snapshot_capture'
  | 'note_snapshot_get'
  | 'note_snapshot_list'
  | 'note_snapshot_restore'
  | 'note_summaries_map'
  | 'note_tags_index'
  | 'note_toggle_content_lock'
  | 'note_toggle_favorite'
  | 'note_trash_count'
  | 'note_trash_list'
  | 'note_unarchive'
  | 'note_update'
  | 'note_year_histogram'
  | 'notify_send'
  | 'pet_asset_clear'
  | 'pet_asset_preview'
  | 'pet_asset_set'
  | 'pet_assets_list'
  | 'pet_bubble_clip'
  | 'pet_bubble_close'
  | 'pet_bubble_notice'
  | 'pet_bubble_resize'
  | 'pet_bubble_state'
  | 'pet_bubble_toggle'
  | 'pet_chat'
  | 'pet_chat_clear'
  | 'pet_chat_delete'
  | 'pet_chat_history'
  | 'pet_chat_read_attach'
  | 'pet_chat_rewind'
  | 'pet_close'
  | 'pet_conversation_save'
  | 'pet_menu_popup'
  | 'pet_note_create'
  | 'pet_notifications'
  | 'pet_open_main'
  | 'pet_package_asset'
  | 'pet_package_install'
  | 'pet_package_install_url'
  | 'pet_package_remove'
  | 'pet_package_select'
  | 'pet_packages_import_codex'
  | 'pet_packages_list'
  | 'pet_position_reset'
  | 'pet_screenshot_capture'
  | 'pet_session_list'
  | 'pet_session_new'
  | 'pet_session_open'
  | 'pet_set_enabled'
  | 'pet_set_position'
  | 'pet_set_visible'
  | 'pet_theme'
  | 'phrase_pack_save'
  | 'phrase_packs_list'
  | 'region_registry'
  | 'routine_history'
  | 'routine_today'
  | 'routine_toggle'
  | 'schedule_today'
  | 'search_notes'
  | 'section_create'
  | 'section_create_with_body'
  | 'section_delete'
  | 'section_import_file'
  | 'section_import_scan'
  | 'section_move'
  | 'section_purge'
  | 'section_reorder'
  | 'section_restore'
  | 'section_trash_list'
  | 'section_update'
  | 'section_window_close'
  | 'section_window_list'
  | 'section_window_open'
  | 'settings_get_all'
  | 'settings_set'
  | 'sheet_set_cells'
  | 'slide_preview_render'
  | 'source_add_file'
  | 'source_add_text'
  | 'source_delete'
  | 'source_rename'
  | 'suggestion_set_status'
  | 'suggestions_list'
  | 'sync_regenerate_token'
  | 'sync_set_enabled'
  | 'sync_status'
  | 'tag_colors'
  | 'tag_counts'
  | 'tag_delete'
  | 'tag_merge'
  | 'tag_rename'
  | 'tag_set_color'
  | 'theme_defaults'
  | 'theme_export'
  | 'theme_read'
  | 'timeline_routine_create'
  | 'timeline_routine_delete'
  | 'timeline_routine_list'
  | 'timeline_routine_update'
  | 'todo_toggle'
  | 'weather_forecast'
  | 'workspace_bg_base_dir'
  | 'workspace_clear_bg_image'
  | 'workspace_create'
  | 'workspace_delete'
  | 'workspace_duplicate'
  | 'workspace_era_add'
  | 'workspace_era_list'
  | 'workspace_era_remove'
  | 'workspace_list'
  | 'workspace_region_add'
  | 'workspace_region_list'
  | 'workspace_region_remove'
  | 'workspace_rename'
  | 'workspace_set_bg_image'
  | 'workspace_set_icon'
  | 'workspace_status_add'
  | 'workspace_status_list'
  | 'workspace_status_remove'
  | 'workspace_status_rename';
