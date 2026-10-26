import { useEffect, useState } from "react";
import { call } from "./invoke";
import { isBrowser } from "./env";

/**
 * Factory for a module-level cache of a Tauri-resolved base directory + the
 * `convertFileSrc` helper, keyed by which base-dir command to call.
 * attachmentsBase.ts and workspaceBgBase.ts were previously two
 * byte-near-identical copies of this same hook (one per Tauri command) — this
 * factory is the single implementation both now delegate to. Each call to
 * createBaseDirCache closes over its own `baseCache`/`convertCache`/
 * `basePromise`, so the two consumers never share cached state with each
 * other.
 */
export function createBaseDirCache(command: string) {
  let baseCache: string | null = null;
  let convertCache: ((path: string) => string) | null = null;
  let basePromise: Promise<void> | null = null;

  /**
   * Resolves the on-disk base directory for `command` and the Tauri
   * `convertFileSrc` function, caching both at module scope so every
   * consumer shares one lookup. Safe to call outside Tauri (vite/tests) —
   * the dynamic import + call() are guarded and simply leave both values
   * null.
   */
  return function useBaseDirCache(): { baseDir: string | null; convert: ((path: string) => string) | null } {
    const [baseDir, setBaseDir] = useState<string | null>(baseCache);

    useEffect(() => {
      if (baseCache) return;
      // `${command}` (attachments/emoji/workspace-bg _base_dir) is a local-FS path — excluded
      // over HTTP entirely. Calling it in browser mode would just 404 on every mount and toast
      // an error the user can't act on; skip it outright and leave both caches null (callers
      // already treat null as "not resolvable", e.g. attachmentsBase.ts substitutes its own
      // browser-mode URL builder instead of relying on this cache at all).
      if (isBrowser()) return;
      if (!basePromise) {
        basePromise = (async () => {
          try {
            const core = await import("@tauri-apps/api/core");
            convertCache = core.convertFileSrc;
            const res = (await call(command, {})) as { base: string };
            baseCache = res.base;
          } catch {
            // not running under Tauri (vite/tests) — leave both caches null
          }
        })();
      }
      void basePromise.then(() => setBaseDir(baseCache));
    }, []);

    return { baseDir, convert: convertCache };
  };
}
