import { createBaseDirCache } from "./baseDirCache";

/**
 * Shared module-level cache for the workspace-background-image base directory +
 * the Tauri convertFileSrc helper. Mirrors attachmentsBase.ts exactly, but points
 * at the separate workspace_bg/ root (kept apart from attachments/ so
 * attachments::orphan_cleanup never mistakes it for an orphaned note directory —
 * see src-tauri/src/db/mod.rs::WORKSPACE_BG_DIR).
 */
export const useWorkspaceBgBase = createBaseDirCache("workspace_bg_base_dir");
