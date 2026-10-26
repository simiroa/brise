import { useSearchStore } from "../stores/search";
import { t } from "../i18n/t";
import { MobileCalendarView } from "./MobileCalendarView";
import { MobileTimelineView } from "./MobileTimelineView";
import { MobileGalleryView } from "./MobileGalleryView";
import { MobileRegionView } from "./MobileRegionView";
import { MobileChatView } from "./MobileChatView";

interface MobileExpandedViewProps {
  onOpenNote: (id: string) => void;
}

/**
 * Mobile mirror of leftpanel/expanded/index.tsx's ExpandedFilterView — MobileHome renders this
 * for every filterMode except "tree" (which stays MobileNoteTree), exactly matching desktop's
 * `filterMode === "tree" ? <NoteTree/> : <ExpandedFilterView/>` split (leftpanel/index.tsx:175).
 * Same per-mode mapping as that switch. `region` = the desktop sidebar region view in view-only mode
 * (owner 2026-10-06; maplibre stays a lazy chunk loaded only when this tab opens — formerly excluded
 * as D6). `chat` = the desktop SidebarChat over HTTP (owner 2026-10-06, formerly D7). Anything
 * unmapped falls to the "unavailable" notice rather than crashing (e.g. a stale persisted mode).
 */
export function MobileExpandedView({ onOpenNote }: MobileExpandedViewProps) {
  const filterMode = useSearchStore((s) => s.filterMode);

  switch (filterMode) {
    case "timeline":
      return <MobileTimelineView onOpenNote={onOpenNote} />;
    case "gallery":
      return <MobileGalleryView onOpenNote={onOpenNote} />;
    case "calendar":
      return <MobileCalendarView onOpenNote={onOpenNote} />;
    case "region":
      return <MobileRegionView onOpenNote={onOpenNote} />;
    case "chat":
      return <MobileChatView onOpenNote={onOpenNote} />;
    default:
      return (
        <div className="mobile-list scroll">
          <div className="mobile-empty">{t("mobile.view_unavailable_here")}</div>
        </div>
      );
  }
}
