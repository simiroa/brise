/**
 * Shared "new note at lat/lng" popover for empty-map click and place-search pick.
 * Thin adapter over CreatePopover: adds the portal + full-screen backdrop the map tab needs
 * (WorldMap's own click handler would otherwise re-fire under the popover) and autofocuses
 * confirm on each new pin — both map-specific, so they stay here rather than in the shared
 * component.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/t";
import { CreatePopover } from "./CreatePopover";

export type CreatePin = {
  lat: number;
  lng: number;
  /** Screen anchor for the popover (client coords). */
  clientX: number;
  clientY: number;
  /** Optional place label from geocode search / reverse. */
  label?: string | null;
};

interface MapCreatePopoverProps {
  pin: CreatePin;
  creating: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MapCreatePopover({ pin, creating, onConfirm, onCancel }: MapCreatePopoverProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, [pin.lat, pin.lng]);

  const label = pin.label?.trim() || `${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`;

  return createPortal(
    <>
      <div
        data-testid="home-map-create-backdrop"
        onClick={onCancel}
        onContextMenu={(e) => {
          e.preventDefault();
          onCancel();
        }}
        style={{ position: "fixed", inset: 0, zIndex: "var(--z-backdrop)" }}
      />
      <CreatePopover
        testId="home-map-create-popover"
        anchor={{ x: pin.clientX, y: pin.clientY }}
        ariaLabel={t("home.map_create_here")}
        title={t("home.map_create_here")}
        subtitle={
          <span
            title={label}
            style={{
              display: "block",
              maxWidth: 260,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
        }
        confirmLabel={t("home.map_create")}
        cancelLabel={t("home.map_cancel")}
        confirmTestId="home-map-create-confirm"
        cancelTestId="home-map-create-cancel"
        creating={creating}
        onConfirm={onConfirm}
        onCancel={onCancel}
        confirmRef={confirmRef}
      />
    </>,
    document.body
  );
}
