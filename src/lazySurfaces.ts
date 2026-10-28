/**
 * 앱의 지연 로드 화면 레지스트리 — 화면마다 **정의는 여기 한 번**이다(src/lib/lazyPreload.ts 머리 주석).
 *
 * 한 곳에 모으는 이유: 같은 모달을 여러 파일이 각자 lazy() 로 만들면(AI 일괄 정리 모달 6벌, AI 계획 검토 5벌,
 * 시트 차트 3벌이었다) 한 정의를 미리 받아도 다른 정의는 여전히 대기 화면을 거친다. 새 지연 화면은 여기에
 * 추가하고, 여는 버튼에 preloadIntentProps(X) 를 펼친다. 맨 React.lazy 는 check:surface ⓔ 가 막는다.
 *
 * idle: 그 창 그룹이 부팅을 마친 뒤 한가할 때 미리 받는다 — 자주 쓰는 화면만("main" = 본 창, "settings" = 설정 창).
 * 나머지는 여는 버튼의 의도(마우스 올림·포커스·누르기 시작)로 받는다.
 */
import { lazyPreload } from "./lib/lazyPreload";

export const LazyActivityHistoryPanel = lazyPreload(() => import("./components/ActivityHistoryPanel").then((m) => ({ default: m.ActivityHistoryPanel })), { name: "LazyActivityHistoryPanel" });
export const AiActionsCard = lazyPreload(() => import("./components/settings/AiActionsCard").then((m) => ({ default: m.AiActionsCard })), { name: "AiActionsCard", idle: "settings" });
export const AiAgentReviewModal = lazyPreload(() => import("./components/AiAgentReviewModal").then((m) => ({ default: m.AiAgentReviewModal })), { name: "AiAgentReviewModal" });
export const AiBatchOrganizeModal = lazyPreload(() => import("./components/AiBatchOrganizeModal").then((m) => ({ default: m.AiBatchOrganizeModal })), { name: "AiBatchOrganizeModal" });
export const AiCapabilityCatalog = lazyPreload(() => import("./components/settings/AiCapabilityCatalog").then((m) => ({ default: m.AiCapabilityCatalog })), { name: "AiCapabilityCatalog", idle: "settings" });
export const AiChatSection = lazyPreload(() => import("./components/settings/AiChatSection").then((m) => ({ default: m.AiChatSection })), { name: "AiChatSection", idle: "settings" });
export const AiPermissionsSection = lazyPreload(() => import("./components/settings/AiPermissionsSection").then((m) => ({ default: m.AiPermissionsSection })), { name: "AiPermissionsSection", idle: "settings" });
export const AiPresetsSection = lazyPreload(() => import("./components/settings/AiPresetsSection").then((m) => ({ default: m.AiPresetsSection })), { name: "AiPresetsSection", idle: "settings" });
export const AiProviderSection = lazyPreload(() => import("./components/settings/AiProviderSection").then((m) => ({ default: m.AiProviderSection })), { name: "AiProviderSection", idle: "settings" });
export const AskAiModal = lazyPreload(() => import("./components/AskAiModal").then((m) => ({ default: m.AskAiModal })), { name: "AskAiModal", idle: "main" });
export const BriefingSection = lazyPreload(() => import("./components/settings/BriefingSection").then((m) => ({ default: m.BriefingSection })), { name: "BriefingSection", idle: "settings" });
export const CalendarTab = lazyPreload(() => import("./components/home/CalendarTab").then((m) => ({ default: m.CalendarTab })), { name: "CalendarTab", idle: "main" });
export const ChartEditor = lazyPreload(() => import("./components/sheet/ChartEditor").then((m) => ({ default: m.ChartEditor })), { name: "ChartEditor" });
export const ChartRefPreview = lazyPreload(() => import("./components/preview/ChartRefPreview").then((m) => ({ default: m.ChartRefPreview })), { name: "ChartRefPreview" });
export const CollectSection = lazyPreload(() => import("./components/settings/CollectSection").then((m) => ({ default: m.CollectSection })), { name: "CollectSection", idle: "settings" });
export const DashboardTabsSection = lazyPreload(() => import("./components/settings/DashboardTabsSection").then((m) => ({ default: m.DashboardTabsSection })), { name: "DashboardTabsSection", idle: "settings" });
export const AttachmentsSection = lazyPreload(() => import("./components/settings/AttachmentsSection").then((m) => ({ default: m.AttachmentsSection })), { name: "AttachmentsSection", idle: "settings" });
export const DataManagementSection = lazyPreload(() => import("./components/settings/DataManagementSection").then((m) => ({ default: m.DataManagementSection })), { name: "DataManagementSection", idle: "settings" });
export const DiagramSection = lazyPreload(() => import("./components/diagram/DiagramSection").then((m) => ({ default: m.DiagramSection })), { name: "DiagramSection", idle: "main" });
export const DocPreview = lazyPreload(() => import("./components/preview/DocPreview").then((m) => ({ default: m.DocPreview })), { name: "DocPreview" });
export const EditorPanel = lazyPreload(() => import("./components/EditorPanel").then((m) => ({ default: m.EditorPanel })), { name: "EditorPanel", idle: "main" });
export const EmojiGrid = lazyPreload(() => import("./components/emoji/EmojiGrid").then((m) => ({ default: m.EmojiGrid })), { name: "EmojiGrid" });
export const FlowCanvas = lazyPreload(() => import("./components/diagram/FlowCanvas").then((m) => ({ default: m.FlowCanvas })), { name: "FlowCanvas", idle: "main" });
export const FootnotePreview = lazyPreload(() => import("./components/preview/FootnotePreview").then((m) => ({ default: m.FootnotePreview })), { name: "FootnotePreview" });
export const GraphTab = lazyPreload(() => import("./components/home/graph/GraphTab").then((m) => ({ default: m.GraphTab })), { name: "GraphTab", idle: "main" });
export const HomeMapPane = lazyPreload(() => import("./components/home/HomeMapPane").then((m) => ({ default: m.HomeMapPane })), { name: "HomeMapPane", idle: "main" });
export const ImagePreview = lazyPreload(() => import("./components/preview/ImagePreview").then((m) => ({ default: m.ImagePreview })), { name: "ImagePreview", idle: "main" });
export const InternalNotePreview = lazyPreload(() => import("./components/preview/InternalNotePreview").then((m) => ({ default: m.InternalNotePreview })), { name: "InternalNotePreview" });
export const LazyAiConfirmModal = lazyPreload(() => import("./components/AiConfirmModal").then((m) => ({ default: m.AiConfirmModal })), { name: "LazyAiConfirmModal", idle: "main" });
export const LazyAiResultModal = lazyPreload(() => import("./components/AiResultModal").then((m) => ({ default: m.AiResultModal })), { name: "LazyAiResultModal", idle: "main" });
export const LazyArchiveModal = lazyPreload(() => import("./components/ArchiveModal").then((m) => ({ default: m.ArchiveModal })), { name: "LazyArchiveModal" });
export const LazyBrowserAuxOverlay = lazyPreload(() => import("./components/BrowserAuxOverlay").then((m) => ({ default: m.BrowserAuxOverlay })), { name: "LazyBrowserAuxOverlay" });
export const LazyExportModal = lazyPreload(() => import("./components/export/ExportModal").then((m) => ({ default: m.ExportModalHost })), { name: "LazyExportModal" });
export const LazyFilterModal = lazyPreload(() => import("./components/leftpanel/FilterModal").then((m) => ({ default: m.FilterModal })), { name: "LazyFilterModal" });
export const LazyFolderOrganizeModal = lazyPreload(() => import("./components/FolderOrganizeModal").then((m) => ({ default: m.FolderOrganizeModal })), { name: "LazyFolderOrganizeModal" });
export const LazyOnboardingWizard = lazyPreload(() => import("./components/onboarding/OnboardingWizard").then((m) => ({ default: m.OnboardingWizard })), { name: "LazyOnboardingWizard" });
export const LazySettingsPanel = lazyPreload(() => import("./components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })), { name: "LazySettingsPanel" });
export const LazyTrashModal = lazyPreload(() => import("./components/TrashModal").then((m) => ({ default: m.TrashModal })), { name: "LazyTrashModal" });
export const LicenseSection = lazyPreload(() => import("./components/settings/LicenseSection").then((m) => ({ default: m.LicenseSection })), { name: "LicenseSection", idle: "settings" });
export const LinkReaderPreview = lazyPreload(() => import("./components/preview/LinkReaderPreview").then((m) => ({ default: m.LinkReaderPreview })), { name: "LinkReaderPreview" });
export const MobileNote = lazyPreload(() => import("./mobile/MobileNote").then((m) => ({ default: m.MobileNote })), { name: "MobileNote" });
export const NoteDatesList = lazyPreload(() => import("./components/attachments/NoteDatesList").then((m) => ({ default: m.NoteDatesList })), { name: "NoteDatesList" });
export const NotePreview = lazyPreload(() => import("./components/preview/NotePreview").then((m) => ({ default: m.NotePreview })), { name: "NotePreview", idle: "main" });
export const NoteRegionsList = lazyPreload(() => import("./components/attachments/NoteRegionsList").then((m) => ({ default: m.NoteRegionsList })), { name: "NoteRegionsList" });
export const NotificationsSection = lazyPreload(() => import("./components/settings/NotificationsSection").then((m) => ({ default: m.NotificationsSection })), { name: "NotificationsSection", idle: "settings" });
export const PetSection = lazyPreload(() => import("./components/settings/PetSection").then((m) => ({ default: m.PetSection })), { name: "PetSection", idle: "settings" });
export const PresetManageModal = lazyPreload(() => import("./components/presets/PresetManageModal").then((m) => ({ default: m.PresetManageModal })), { name: "PresetManageModal" });
export const RegionExpanded = lazyPreload(() => import("./components/leftpanel/expanded/RegionExpanded").then((m) => ({ default: m.RegionExpanded })), { name: "RegionExpanded" });
export const RegionPreview = lazyPreload(() => import("./components/preview/RegionPreview").then((m) => ({ default: m.RegionPreview })), { name: "RegionPreview" });
export const SectionPreview = lazyPreload(() => import("./components/preview/SectionPreview").then((m) => ({ default: m.SectionPreview })), { name: "SectionPreview", idle: "main" });
export const SheetAssist = lazyPreload(() => import("./components/assist/SheetAssist").then((m) => ({ default: m.SheetAssist })), { name: "SheetAssist", idle: "main" });
export const SheetChart = lazyPreload(() => import("./components/sheet/SheetChart").then((m) => ({ default: m.SheetChart })), { name: "SheetChart", idle: "main" });
export const SheetSection = lazyPreload(() => import("./components/sheet/SheetSection").then((m) => ({ default: m.SheetSection })), { name: "SheetSection", idle: "main" });
export const SourcePreview = lazyPreload(() => import("./components/preview/SourcePreview").then((m) => ({ default: m.SourcePreview })), { name: "SourcePreview", idle: "main" });
export const SyncSection = lazyPreload(() => import("./components/settings/SyncSection").then((m) => ({ default: m.SyncSection })), { name: "SyncSection", idle: "settings" });
export const TextAssist = lazyPreload(() => import("./components/assist/TextAssist").then((m) => ({ default: m.TextAssist })), { name: "TextAssist", idle: "main" });
export const TimelineTab = lazyPreload(() => import("./components/home/timeline/TimelineTab").then((m) => ({ default: m.TimelineTab })), { name: "TimelineTab", idle: "main" });
export const VideoPreview = lazyPreload(() => import("./components/preview/VideoPreview").then((m) => ({ default: m.VideoPreview })), { name: "VideoPreview" });
export const ViewSection = lazyPreload(() => import("./components/settings/ViewSection").then((m) => ({ default: m.ViewSection })), { name: "ViewSection", idle: "settings" });
export const WorldMapGL = lazyPreload(() => import("./components/map/WorldMapGL").then((m) => ({ default: m.WorldMapGL })), { name: "WorldMapGL", idle: "main" });
