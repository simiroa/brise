import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { call, callSilent } from "../../../lib/invoke";
import { reportFallback } from "../../../lib/diag";
import { t } from "../../../i18n/t";
import { useFileDropZone } from "../../../lib/useFileDropZone";
import { groupCardStyle } from "../shared";
import { SectionHeader } from "../SectionHeader";
import { PromptDialog } from "../../PromptDialog";
import { ContextMenuShell } from "../../common/ContextMenuShell";
import { IconClose, IconPlus, IconSmile, IconTrash } from "../../icons";
import { IconAction } from "../IconAction";
import { HintBadge } from "../HintBadge";
import { CodexPetAtlas } from "../../../plugins/pet/CodexPetAtlas";
import { PetSvg } from "../../../plugins/pet/PetSprite";
import type { PetPackage, PetPackageAssetOutput } from "../../../lib/commands.gen";

/**
 * 설정 > 펫 — "캐릭터" 그룹 (PET.md §0.6, 2026-10-16 재설계).
 *
 * 미리보기(`preview` 슬롯)와 갤러리가 한 카드다 — 썸네일을 누르면 바로 옆 미리보기가 바뀐다.
 * 추가 경로는 "+ 캐릭터 추가" 메뉴 하나(파일 · 폴더 · Codex · URL)이고, 카드 전체가 드롭 존이다
 * (zip · 폴더 · pet.json · 이미지 여러 개 동시). 설치가 도는 동안은 추가 단추가 잠기고 진행 줄이 뜬다.
 * 클릭 = 선택(accent 테두리). 삭제 단추는 호버 **또는 키보드 포커스**에 보인다 — 늘 DOM 에 있어
 * Tab 으로 닿고, 포커스가 오면 드러난다.
 * 아틀라스는 항목당 최대 8MiB라 **보이는 것만** 지연 로드한다 — 목록은 metadata만 싣는다.
 */

const THUMB_SIZE = 84;
const THUMB_H = (THUMB_SIZE * 208) / 192;

type PetPackageView = PetPackage & { dialect?: string; has_preview?: boolean };

/** 썸네일 타일(기본 캐릭터와 설치 패키지가 같은 모양) — 선택이면 accent 테두리. */
function tileStyle(selected: boolean): CSSProperties {
  return {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-3)",
    border: `1px solid ${selected ? "var(--accent)" : "var(--divider)"}`,
    boxShadow: selected ? "0 0 0 1px var(--accent)" : "none",
    borderRadius: "var(--radius-md)",
    background: "transparent",
    cursor: "pointer",
  };
}

const THUMB_FRAME: CSSProperties = { height: THUMB_H, display: "grid", placeItems: "center" };

const TILE_LABEL: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

/** 백엔드 `pet_install:<code>` 토큰 → 로케일 문구. serde 원문은 숨긴다. */
export function installErrorText(message: string): string {
  const raw = (message ?? "").trim();
  const tokenMatch = raw.match(/pet_install:[a-z0-9_]+(?::[^\s,;]+)?/i);
  const token = tokenMatch ? tokenMatch[0] : raw;
  const lower = token.toLowerCase();

  if (lower.startsWith("pet_install:bad_atlas:")) {
    const size = token.slice(token.toLowerCase().indexOf("bad_atlas:") + "bad_atlas:".length);
    return t("settings.pet_install_bad_atlas", { size });
  }
  if (lower.startsWith("pet_install:")) {
    const code = lower.slice("pet_install:".length);
    switch (code) {
      case "missing_id":
        return t("settings.pet_install_missing_id");
      case "bad_id":
        return t("settings.pet_install_bad_id");
      case "missing_sheet":
        return t("settings.pet_install_missing_sheet");
      case "sheet_missing_from_zip":
        return t("settings.pet_install_sheet_missing_from_zip");
      case "no_manifest":
        return t("settings.pet_install_no_manifest");
      case "bad_zip":
        return t("settings.pet_install_bad_zip");
      case "too_large":
        return t("settings.pet_install_too_large");
      case "no_alpha":
        return t("settings.pet_install_no_alpha");
      case "unsupported":
        return t("settings.pet_install_unsupported");
      case "no_idle":
        return t("settings.pet_install_no_idle");
      case "bad_url":
        return t("settings.pet_install_bad_url");
      default:
        return t("settings.pet_install_generic");
    }
  }
  if (/missing field/i.test(raw) || /at line \d+ column \d+/i.test(raw)) {
    return t("settings.pet_install_generic");
  }
  return raw || t("settings.pet_install_generic");
}

async function installOne(path: string): Promise<string | null> {
  try {
    await callSilent("pet_package_install", { path });
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

/** 파일 경로의 마지막 조각 — 실패 목록에 전체 경로를 늘어놓지 않는다. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function urlLabel(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || u.host || url;
  } catch {
    return url;
  }
}

function PetPackageThumb({
  pkg,
  onSelect,
  onRequestRemove,
}: {
  pkg: PetPackageView;
  onSelect: (id: string) => void;
  onRequestRemove: (pkg: PetPackage) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const hasPreview = pkg.has_preview === true;
  const useImgThumb = hasPreview || pkg.dialect === "idle-image";

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const args: Record<string, unknown> = hasPreview && pkg.dialect !== "idle-image" ? { id: pkg.id, preview: true } : { id: pkg.id };
      // callSilent(...).catch(...) — 썸네일 한 장이 없다고 토스트를 띄우지 않는다(CLAUDE.md 함정 8).
      void callSilent<PetPackageAssetOutput>("pet_package_asset", args)
        .then((r) => {
          if (!cancelled) setDataUrl(r.data_url);
        })
        .catch(() => {});
    };
    // IntersectionObserver 가 없는 환경(jsdom)은 즉시 로드로 폴백한다.
    if (typeof IntersectionObserver === "undefined" || !ref.current) {
      load();
      return () => {
        cancelled = true;
      };
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        load();
      }
    });
    io.observe(ref.current);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [pkg.id, hasPreview, pkg.dialect]);

  return (
    <div
      ref={ref}
      style={{ position: "relative" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <button
        type="button"
        data-testid={`settings-pet-package-${pkg.id}`}
        aria-pressed={pkg.selected}
        onClick={() => onSelect(pkg.id)}
        style={tileStyle(pkg.selected)}
      >
        <span style={THUMB_FRAME}>
          {dataUrl ? (
            useImgThumb ? (
              <img
                src={dataUrl}
                alt=""
                width={THUMB_SIZE}
                height={THUMB_SIZE}
                draggable={false}
                style={{ objectFit: "contain" }}
              />
            ) : (
              <CodexPetAtlas
                dataUrl={dataUrl}
                size={THUMB_SIZE}
                rows={pkg.rows}
                clips={pkg.clips}
                reducedMotion
                label={pkg.display_name}
              />
            )
          ) : null}
        </span>
        <span style={TILE_LABEL}>{pkg.display_name}</span>
      </button>
      {/* 늘 DOM 에 둔다(Tab 으로 닿게) — 호버나 키보드 포커스가 들어오면 드러난다. */}
      <IconAction
        icon={<IconTrash size={14} strokeWidth={2} />}
        label={t("settings.pet_package_delete")}
        size="sm"
        danger
        data-testid={`settings-pet-package-remove-${pkg.id}`}
        data-revealed={hover || focusWithin ? "true" : "false"}
        onClick={() => onRequestRemove(pkg)}
        style={{
          position: "absolute",
          top: "var(--space-1)",
          right: "var(--space-1)",
          opacity: hover || focusWithin ? 1 : 0,
        }}
      />
    </div>
  );
}

function DefaultCharacterTile({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-testid="settings-pet-package-default"
      aria-pressed={selected}
      onClick={onSelect}
      style={tileStyle(selected)}
    >
      <span style={THUMB_FRAME}>
        <PetSvg mood="idle" size={THUMB_SIZE} />
      </span>
      <span style={TILE_LABEL}>{t("settings.pet_package_default")}</span>
    </button>
  );
}

export function PetPackageGallery({
  packages,
  onSelect,
  onChanged,
  preview,
}: {
  packages: PetPackage[];
  onSelect: (id: string) => void;
  /** 설치/삭제 후 목록을 다시 읽어달라는 신호(소유는 PetSection). */
  onChanged: () => void;
  /** 갤러리 왼쪽에 붙는 큰 미리보기(소유는 PetSection). */
  preview?: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pendingRemove, setPendingRemove] = useState<PetPackage | null>(null);
  const [failures, setFailures] = useState<{ name: string; reason: string }[]>([]);
  const [urlOpen, setUrlOpen] = useState(false);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  // 설치가 도는 중(파일·폴더·드롭·URL·Codex 공통) — 추가 단추를 잠그고 진행 줄을 띄운다. URL 과 Codex 는
  // 내려받기·여러 개 변환이라 수 초가 걸린다.
  const [installing, setInstalling] = useState(false);
  const withInstalling = useCallback(async (run: () => Promise<void>) => {
    setInstalling(true);
    try {
      await run();
    } finally {
      setInstalling(false);
    }
  }, []);

  // 버튼 · 드롭 · URL 이 같은 실패 배너로 모인다. callSilent 이라 serde 토스트가 겹치지 않는다.
  const installAll = useCallback(
    (paths: string[]) =>
      withInstalling(async () => {
        const failed: { name: string; reason: string }[] = [];
        for (const path of paths) {
          const reason = await installOne(path);
          if (reason) failed.push({ name: baseName(path), reason });
        }
        setFailures(failed);
        onChanged();
      }),
    [onChanged, withInstalling],
  );

  // 파일과 폴더는 OS 대화상자가 한 번에 못 고른다 — 메뉴 항목 둘이 같은 설치 경로로 모인다.
  const pickPackage = async (directory: boolean) => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open(
        directory
          ? { directory: true, multiple: false }
          : {
              multiple: false,
              filters: [
                {
                  name: t("settings.pet_preset_manifest_filter"),
                  extensions: ["zip", "json", "png", "gif", "webp", "apng"],
                },
              ],
            },
      );
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await installAll(paths);
    } catch (e) {
      reportFallback("pet", "package_dialog_failed", errorMessage(e));
    }
  };

  const installUrl = (url: string) =>
    withInstalling(async () => {
      try {
        await callSilent("pet_package_install_url", { url });
        setFailures([]);
        onChanged();
      } catch (e) {
        setFailures([{ name: urlLabel(url), reason: errorMessage(e) }]);
      }
    });

  const importCodex = () =>
    withInstalling(async () => {
      try {
        const r = await callSilent<{ installed?: string[]; failed?: { name: string; reason: string }[] }>(
          "pet_packages_import_codex",
          {},
        );
        setFailures(r.failed ?? []);
        onChanged();
      } catch (e) {
        setFailures([{ name: t("settings.pet_codex_import"), reason: errorMessage(e) }]);
      }
    });

  // 섹션 가져오기와 같은 공용 훅(lib/useFileDropZone) — 새 구독 로직을 만들지 않는다.
  const { dragOver } = useFileDropZone(() => rootRef.current, {
    onDrop: (paths, _pos, inside) => {
      if (!inside || paths.length === 0 || installing) return;
      void installAll(paths);
    },
  });

  const remove = async (id: string) => {
    setPendingRemove(null);
    try {
      // 사용자가 누른 삭제가 실패하면 토스트가 필요하다(CLAUDE.md 함정 8) — call() + try/catch.
      await call("pet_package_remove", { id });
    } catch {
      /* 아래 onChanged 가 실제 상태를 되읽는다 — 목록은 낙관적으로 바꾸지 않았다 */
    }
    onChanged();
  };

  const defaultSelected = !packages.some((item) => item.selected);

  const addItems: { id: string; label: string; run: () => void }[] = [
    { id: "file", label: t("settings.pet_add_file"), run: () => void pickPackage(false) },
    { id: "folder", label: t("settings.pet_add_folder"), run: () => void pickPackage(true) },
    { id: "codex", label: t("settings.pet_codex_import"), run: () => void importCodex() },
    { id: "url", label: t("settings.pet_install_url"), run: () => setUrlOpen(true) },
  ];

  return (
    <div
      ref={rootRef}
      className="card"
      style={{
        ...groupCardStyle,
        outline: dragOver ? "1px dashed var(--accent)" : undefined,
        outlineOffset: dragOver ? -1 : undefined,
      }}
      data-testid="settings-pet-gallery"
    >
      <SectionHeader
        title={t("settings.pet_character_section")}
        icon={<IconSmile size={14} strokeWidth={2} />}
        actions={
          <button
            type="button"
            className="btn btn--sm"
            data-testid="settings-pet-add"
            aria-haspopup="menu"
            aria-busy={installing || undefined}
            disabled={installing}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setAddMenu({ x: r.left, y: r.bottom + 4 });
            }}
            style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}
          >
            <IconPlus size={14} />
            {t("settings.pet_preset_install")}
          </button>
        }
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)", alignItems: "flex-start" }}>
        {preview}
        <div
          data-testid="settings-pet-gallery-drop"
          role="group"
          aria-label={t("settings.pet_preset_label")}
          style={{
            flex: "1 1 260px",
            minWidth: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))",
            gap: "var(--space-3)",
            borderRadius: "var(--radius-md)",
            background: dragOver ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
          }}
        >
          <DefaultCharacterTile selected={defaultSelected} onSelect={() => onSelect("default")} />
          {packages.map((pkg) => (
            <PetPackageThumb
              key={pkg.id}
              pkg={pkg}
              onSelect={onSelect}
              onRequestRemove={setPendingRemove}
            />
          ))}
          <div
            style={{
              gridColumn: "1 / -1",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              fontSize: "var(--text-sm)",
              color: "var(--muted)",
            }}
            aria-label={packages.length === 0 ? t("settings.pet_preset_empty") : undefined}
          >
            {/* 사용자 문구는 짧게, 형식·크기 같은 기술 정보는 ⓘ 뱃지로. */}
            <span>{t("settings.pet_package_drop")}</span>
            <HintBadge hint={t("settings.pet_package_format_hint")} />
          </div>
        </div>
      </div>

      <ContextMenuShell anchor={addMenu} onClose={() => setAddMenu(null)} minWidth={220} testId="settings-pet-add-menu">
        {addItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className="menu-row menu-item"
            data-testid={`settings-pet-add-${item.id}`}
            style={{ color: "inherit" }}
            onClick={() => {
              setAddMenu(null);
              item.run();
            }}
          >
            <span>{item.label}</span>
          </button>
        ))}
      </ContextMenuShell>

      {installing && (
        <div
          role="status"
          data-testid="settings-pet-installing"
          style={{ margin: "var(--space-3) 0 0", fontSize: "var(--text-sm)", color: "var(--muted)" }}
        >
          {t("settings.pet_installing")}
        </div>
      )}

      {failures.length > 0 && (
        <div
          data-testid="settings-pet-install-failures"
          role="alert"
          style={{
            margin: "var(--space-3) 0 0",
            padding: "var(--space-3)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius-md)",
            fontSize: "var(--text-sm)",
            color: "var(--danger)",
            display: "flex",
            gap: "var(--space-3)",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <ul
            style={{
              margin: 0,
              paddingLeft: "var(--space-5)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
            }}
          >
            {failures.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {f.name}: {installErrorText(f.reason)}
              </li>
            ))}
          </ul>
          <IconAction
            icon={<IconClose size={14} />}
            label={t("settings.pet_install_dismiss")}
            size="sm"
            data-testid="settings-pet-install-dismiss"
            onClick={() => setFailures([])}
          />
        </div>
      )}

      {pendingRemove && (
        <PromptDialog
          mode="confirm"
          danger
          title={t("settings.pet_package_delete")}
          description={t("settings.pet_package_delete_confirm", { name: pendingRemove.display_name })}
          confirmLabel={t("settings.pet_package_delete")}
          onSubmit={() => void remove(pendingRemove.id)}
          onCancel={() => setPendingRemove(null)}
        />
      )}

      {urlOpen && (
        <PromptDialog
          mode="input"
          title={t("settings.pet_install_url_title")}
          placeholder={t("settings.pet_install_url_placeholder")}
          confirmLabel={t("settings.pet_install_url")}
          onSubmit={(value) => {
            setUrlOpen(false);
            const url = (typeof value === "string" ? value : value.value)?.trim();
            if (url) void installUrl(url);
          }}
          onCancel={() => setUrlOpen(false)}
        />
      )}
    </div>
  );
}
