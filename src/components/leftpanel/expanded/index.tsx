import { useSearchStore } from "../../../stores/search";
import { TimelineExpanded } from "./TimelineExpanded";
import { RegionExpanded } from "./RegionExpanded";
import { GalleryExpanded } from "./GalleryExpanded";
import { CalendarExpanded } from "./CalendarExpanded";
import { TimelineFilter } from "../yearfilter/TimelineFilter";
import { SidebarChat } from "../SidebarChat";

/* ── Left-panel view body (non-tree tabs) ──
 * Dispatches on filterMode. Tree is rendered by LeftPanel itself.
 * Timeline keeps its year scrubber above the expanded list (same pairing the
 * old expand path used when mode === "timeline").
 * Advanced filter axes live on FilterModal (not an exclusive body).
 * Region is normally rendered by LeftPanel itself (kept mounted while hidden — see there); the
 * case below stays as the fallback for an unknown mode.
 */
export function ExpandedFilterView() {
  const filterMode = useSearchStore((s) => s.filterMode);

  switch (filterMode) {
    case "timeline":
      return (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              flex: "none",
              padding: "0 var(--sidebar-pad)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <TimelineFilter />
          </div>
          <TimelineExpanded />
        </div>
      );
    case "chat":
      return <SidebarChat />;
    case "gallery":
      return <GalleryExpanded />;
    case "calendar":
      return <CalendarExpanded />;
    case "region":
    default:
      return <RegionExpanded />;
  }
}
