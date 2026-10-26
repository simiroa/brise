import type { SVGProps } from 'react';
// Separate import (not just the re-exported IconSparkles below) — IconAi's wrapper needs the raw
// component to attach its own className/animation, see IconAi below.
import Sparkles from 'lucide-react/dist/esm/icons/sparkles.mjs';

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
  strokeWidth?: number;
}

// Wave R1-b dedup: these used to each go through a `wrap(Comp) = (p) => <Comp {...p} />`
// passthrough HOC — pure identity forwarding with no default props anywhere in this file, so it
// bought nothing over a direct re-export (and dropped ref-forwarding, which lucide's own
// forwardRef components support natively). Same names, same IconProps-compatible call sites.
import IconNote from 'lucide-react/dist/esm/icons/file-text.mjs';
import IconTimeline from 'lucide-react/dist/esm/icons/gantt-chart-square.mjs';
import IconGraph from 'lucide-react/dist/esm/icons/network.mjs';
import IconSettings from 'lucide-react/dist/esm/icons/settings.mjs';
import IconFolder from 'lucide-react/dist/esm/icons/folder.mjs';
import IconFolderOpen from 'lucide-react/dist/esm/icons/folder-open.mjs';
import IconFolderPlus from './animatedIcons/folder-plus';
import IconChevron from 'lucide-react/dist/esm/icons/chevron-down.mjs';
import IconSearch from './animatedIcons/search';
import IconClose from 'lucide-react/dist/esm/icons/x.mjs';
import IconPlus from 'lucide-react/dist/esm/icons/plus.mjs';
import IconStar from 'lucide-react/dist/esm/icons/star.mjs';
import IconPlay from 'lucide-react/dist/esm/icons/play.mjs';
import IconPause from 'lucide-react/dist/esm/icons/pause.mjs';
import IconMagnet from 'lucide-react/dist/esm/icons/magnet.mjs';
import IconBell from 'lucide-react/dist/esm/icons/bell.mjs';
import IconShare from 'lucide-react/dist/esm/icons/share-2.mjs';
import IconImage from 'lucide-react/dist/esm/icons/image.mjs';
import IconDoc from 'lucide-react/dist/esm/icons/file-type.mjs';
import IconLink from './animatedIcons/link';
import IconLock from './animatedIcons/lock';
import IconUnlock from 'lucide-react/dist/esm/icons/unlock.mjs';
import IconHome from './animatedIcons/home';
import IconFocus from './animatedIcons/maximize-2';
import IconExitFocus from './animatedIcons/minimize';
import IconMaximize2 from './animatedIcons/maximize-2';
import IconMore from 'lucide-react/dist/esm/icons/more-vertical.mjs';
// 달력 W9 ②: 끌 수 있는 것에 붙이는 전용 손잡이(점 여섯 개). 카드 본체는 누르는 것이고
// 끄는 것은 이 그립뿐이라는 걸 모양으로 말한다.
import IconGrip from 'lucide-react/dist/esm/icons/grip-vertical.mjs';
import IconMic from 'lucide-react/dist/esm/icons/mic.mjs';
import IconBold from './animatedIcons/bold';
import IconItalic from './animatedIcons/italic';
import IconStrike from 'lucide-react/dist/esm/icons/strikethrough.mjs';
import IconCheck from 'lucide-react/dist/esm/icons/check-square.mjs';
import IconCheckMark from 'lucide-react/dist/esm/icons/check.mjs';
import IconBulletList from 'lucide-react/dist/esm/icons/list.mjs';
import IconOrderedList from 'lucide-react/dist/esm/icons/list-ordered.mjs';
import IconCode from 'lucide-react/dist/esm/icons/code.mjs';
import IconClock from 'lucide-react/dist/esm/icons/clock.mjs';
import IconRefresh from './animatedIcons/refresh-cw';
import IconTrash from 'lucide-react/dist/esm/icons/trash-2.mjs';
import IconEdit from 'lucide-react/dist/esm/icons/pencil.mjs';
import IconMinimize from 'lucide-react/dist/esm/icons/minus.mjs';
import IconMinus from 'lucide-react/dist/esm/icons/minus.mjs';
import IconMaximize from 'lucide-react/dist/esm/icons/square.mjs';
import IconH1 from 'lucide-react/dist/esm/icons/heading-1.mjs';
import IconH2 from 'lucide-react/dist/esm/icons/heading-2.mjs';
import IconH3 from 'lucide-react/dist/esm/icons/heading-3.mjs';
import IconCodeBlock from 'lucide-react/dist/esm/icons/square-code.mjs';
import IconQuote from 'lucide-react/dist/esm/icons/quote.mjs';
import IconFile from 'lucide-react/dist/esm/icons/file.mjs';
import IconFileImport from 'lucide-react/dist/esm/icons/file-input.mjs';
import IconFileExport from 'lucide-react/dist/esm/icons/file-output.mjs';
import IconClipboard from 'lucide-react/dist/esm/icons/clipboard.mjs';
import IconZoomIn from 'lucide-react/dist/esm/icons/zoom-in.mjs';
import IconZoomOut from 'lucide-react/dist/esm/icons/zoom-out.mjs';
import IconExternalLink from './animatedIcons/external-link';
import IconEye from './animatedIcons/eye';
import IconEyeOff from './animatedIcons/eye-off';
import IconPalette from 'lucide-react/dist/esm/icons/palette.mjs';
import IconSpellCheck from 'lucide-react/dist/esm/icons/spell-check-2.mjs';
// AI에게 묻기 타일(components/ai/askAiPresets.ts) — 노트 분리 제안.
import IconScissors from 'lucide-react/dist/esm/icons/scissors.mjs';
import IconTranslate from 'lucide-react/dist/esm/icons/languages.mjs';
import IconBook from 'lucide-react/dist/esm/icons/book.mjs';
import IconScroll from 'lucide-react/dist/esm/icons/scroll-text.mjs';
import IconSparkles from 'lucide-react/dist/esm/icons/sparkles.mjs';
import IconLandmark from 'lucide-react/dist/esm/icons/landmark.mjs';
import IconCrown from 'lucide-react/dist/esm/icons/crown.mjs';
import IconMap from 'lucide-react/dist/esm/icons/map.mjs';
import IconFlag from 'lucide-react/dist/esm/icons/flag.mjs';
import IconGlobe from 'lucide-react/dist/esm/icons/globe.mjs';
import IconInfo from 'lucide-react/dist/esm/icons/info.mjs';
import IconSmartphone from 'lucide-react/dist/esm/icons/smartphone.mjs';
import IconSun from 'lucide-react/dist/esm/icons/sun.mjs';
import IconFeather from './animatedIcons/feather';
import IconSwords from 'lucide-react/dist/esm/icons/swords.mjs';
import IconShield from 'lucide-react/dist/esm/icons/shield.mjs';
import IconNewspaper from 'lucide-react/dist/esm/icons/newspaper.mjs';
import IconHourglass from './animatedIcons/hourglass';
import IconCompass from 'lucide-react/dist/esm/icons/compass.mjs';
import IconAnchor from 'lucide-react/dist/esm/icons/anchor.mjs';
import IconShip from 'lucide-react/dist/esm/icons/ship.mjs';
import IconMountain from 'lucide-react/dist/esm/icons/mountain.mjs';
import IconLeaf from 'lucide-react/dist/esm/icons/leaf.mjs';
import IconFlame from 'lucide-react/dist/esm/icons/flame.mjs';
import IconRepeat from 'lucide-react/dist/esm/icons/repeat.mjs';
import IconMoon from 'lucide-react/dist/esm/icons/moon.mjs';
import IconMusic from 'lucide-react/dist/esm/icons/music.mjs';
import IconCamera from 'lucide-react/dist/esm/icons/camera.mjs';
import IconUsers from './animatedIcons/users';
import IconHeart from 'lucide-react/dist/esm/icons/heart.mjs';
import IconMail from 'lucide-react/dist/esm/icons/mail.mjs';
import IconBriefcase from 'lucide-react/dist/esm/icons/briefcase.mjs';
import IconScale from 'lucide-react/dist/esm/icons/scale.mjs';
import IconGraduation from 'lucide-react/dist/esm/icons/graduation-cap.mjs';
import IconBookmark from 'lucide-react/dist/esm/icons/bookmark.mjs';
import IconFlask from 'lucide-react/dist/esm/icons/flask-conical.mjs';
import IconBuilding from 'lucide-react/dist/esm/icons/building-2.mjs';
import IconSmile from './animatedIcons/smile';
import IconPin from 'lucide-react/dist/esm/icons/pin.mjs';
import IconHighlight from 'lucide-react/dist/esm/icons/highlighter.mjs';
import IconUnderline from './animatedIcons/underline';
import IconTable from 'lucide-react/dist/esm/icons/table.mjs';
import IconClearFormat from 'lucide-react/dist/esm/icons/remove-formatting.mjs';
import IconPaste from 'lucide-react/dist/esm/icons/clipboard-paste.mjs';
import IconCopy from './animatedIcons/copy';
import IconCheckboxEmpty from 'lucide-react/dist/esm/icons/square.mjs';
import IconMapPin from 'lucide-react/dist/esm/icons/map-pin.mjs';
import IconTag from 'lucide-react/dist/esm/icons/tag.mjs';
import IconHistory from './animatedIcons/history';
import IconWrench from 'lucide-react/dist/esm/icons/wrench.mjs';
import IconSummary from 'lucide-react/dist/esm/icons/align-left.mjs';
import IconArrowLeft from './animatedIcons/arrow-left';
import IconPaperclip from 'lucide-react/dist/esm/icons/paperclip.mjs';
import IconMoreHorizontal from 'lucide-react/dist/esm/icons/more-horizontal.mjs';
import IconCalendar from 'lucide-react/dist/esm/icons/calendar.mjs';
import IconTree from 'lucide-react/dist/esm/icons/list-tree.mjs';
import IconFilter from 'lucide-react/dist/esm/icons/list-filter.mjs';
import IconChat from 'lucide-react/dist/esm/icons/message-circle.mjs';
import IconWorkspace from 'lucide-react/dist/esm/icons/layout-template.mjs';
import IconWidget from './animatedIcons/layout-grid';
import IconLayoutGrid from './animatedIcons/layout-grid';
import IconShapes from 'lucide-react/dist/esm/icons/shapes.mjs';
import IconGrid from 'lucide-react/dist/esm/icons/grid-3x3.mjs';
import IconWeather from 'lucide-react/dist/esm/icons/cloud-sun.mjs';
import IconActivity from './animatedIcons/activity';
import IconCalendarDays from 'lucide-react/dist/esm/icons/calendar-days.mjs';
import IconSort from 'lucide-react/dist/esm/icons/arrow-up-down.mjs';
import IconChevronsExpand from './animatedIcons/chevrons-left-right';
import IconChevronsCollapse from './animatedIcons/chevrons-right-left';
import IconArrowUp from './animatedIcons/arrow-up';
import IconArrowDown from './animatedIcons/arrow-down';
import IconArrowRight from './animatedIcons/arrow-right';
import IconRowDelete from 'lucide-react/dist/esm/icons/rows-3.mjs';
import IconColumnDelete from 'lucide-react/dist/esm/icons/columns-3.mjs';
import IconHeaderRowToggle from 'lucide-react/dist/esm/icons/rows-2.mjs';
import IconAsterisk from 'lucide-react/dist/esm/icons/asterisk.mjs';
import IconHelp from 'lucide-react/dist/esm/icons/circle-help.mjs';
import IconAlignLeft from 'lucide-react/dist/esm/icons/align-start-vertical.mjs';
import IconAlignCenterX from 'lucide-react/dist/esm/icons/align-center-vertical.mjs';
import IconAlignRight from 'lucide-react/dist/esm/icons/align-end-vertical.mjs';
import IconAlignTop from 'lucide-react/dist/esm/icons/align-start-horizontal.mjs';
import IconAlignCenterY from 'lucide-react/dist/esm/icons/align-center-horizontal.mjs';
import IconAlignBottom from 'lucide-react/dist/esm/icons/align-end-horizontal.mjs';
import IconDistributeX from 'lucide-react/dist/esm/icons/align-horizontal-distribute-center.mjs';
import IconDistributeY from 'lucide-react/dist/esm/icons/align-vertical-distribute-center.mjs';
import IconImageExport from 'lucide-react/dist/esm/icons/image-down.mjs';
import IconArchive from './animatedIcons/archive';
import IconKanban from 'lucide-react/dist/esm/icons/kanban.mjs';
import IconWallet from 'lucide-react/dist/esm/icons/wallet.mjs';
import IconSheet from 'lucide-react/dist/esm/icons/table-2.mjs';
import IconChart from 'lucide-react/dist/esm/icons/chart-bar.mjs';
import IconUndo from 'lucide-react/dist/esm/icons/undo-2.mjs';
import IconRedo from 'lucide-react/dist/esm/icons/redo-2.mjs';
import IconFmtText from 'lucide-react/dist/esm/icons/type.mjs';
import IconFmtNumber from 'lucide-react/dist/esm/icons/hash.mjs';
import IconFmtCurrency from 'lucide-react/dist/esm/icons/banknote.mjs';
import IconFmtPercent from 'lucide-react/dist/esm/icons/percent.mjs';
import IconDecimalMore from 'lucide-react/dist/esm/icons/decimals-arrow-right.mjs';
import IconDecimalLess from 'lucide-react/dist/esm/icons/decimals-arrow-left.mjs';
import IconRowInsert from 'lucide-react/dist/esm/icons/between-horizontal-start.mjs';
import IconColumnInsert from 'lucide-react/dist/esm/icons/between-vertical-start.mjs';
import IconSortAsc from 'lucide-react/dist/esm/icons/arrow-up-narrow-wide.mjs';
import IconSortDesc from 'lucide-react/dist/esm/icons/arrow-down-wide-narrow.mjs';
import IconEraser from 'lucide-react/dist/esm/icons/eraser.mjs';
import IconLaser from 'lucide-react/dist/esm/icons/circle-dot.mjs';
// 치트시트 제스처 칩(CheatsheetPopover) — 관계도/공간/시트 조작법 팝오버를 텍스트 칩에서
// 아이콘+라벨로. Mouse=휠/포인터 일반, MousePointerClick=클릭, MouseDoubleClick=더블클릭
// (square-mouse-pointer — 사각 커서로 클릭과 실루엣이 다름), Grab=드래그·끌어놓기류 전부.
import IconMouse from 'lucide-react/dist/esm/icons/mouse.mjs';
import IconMousePointerClick from 'lucide-react/dist/esm/icons/mouse-pointer-click.mjs';
import IconMouseDoubleClick from 'lucide-react/dist/esm/icons/square-mouse-pointer.mjs';
import IconGrab from 'lucide-react/dist/esm/icons/grab.mjs';

export {
  IconNote,
  IconTimeline,
  IconGraph,
  IconSettings,
  IconFolder,
  IconFolderOpen,
  // Wave 2 (new-note inbox): 트리 헤더의 "+ 새 폴더" 버튼 — 폴더 의미를 강조하기 위해 일반
  // IconPlus 대신 사용. 사이즈/스트로크는 동일 wrapper 컨벤션을 따른다.
  IconFolderPlus,
  IconChevron,
  IconSearch,
  IconClose,
  IconPlus,
  IconStar,
  // 일정·알림(docs/PLAN-schedule-system.md §7.2): 노트 벨 버튼 — IconStar 와 같은 fill on/off 규격.
  IconBell,
  IconPlay,
  IconPause,
  // 캔버스 스냅 토글 — 직접 그린 격자+자석 글리프를 폐기하고 lucide magnet 으로 통일(2026-10-12).
  IconMagnet,
  IconMagnet as IconSnapMagnet,
  IconShare,
  IconImage,
  IconDoc,
  IconLink,
  IconLock,
  IconUnlock,
  IconHome,
  IconFocus,
  IconExitFocus,
  IconMaximize2,
  IconMore,
  IconGrip,
  IconMic,
  IconBold,
  IconItalic,
  IconStrike,
  IconCheck,
  IconCheckMark,
  IconBulletList,
  IconOrderedList,
  IconCode,
  IconClock,
  IconRefresh,
  IconTrash,
  IconEdit,
  IconMinimize,
  IconMinus,
  IconMaximize,
  IconH1,
  IconH2,
  IconH3,
  IconCodeBlock,
  IconQuote,
  IconFile,
  IconFileImport,
  IconFileExport,
  IconClipboard,
  IconZoomIn,
  IconZoomOut,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconPalette,
  // 에디터 툴바 — 마이크 아이콘 옆 토글(맞춤법 밑줄 / 번역 읽기전용 뷰).
  IconSpellCheck,
  IconTranslate,
  IconScissors,
  // 노트/워크스페이스 아이콘 팔레트(src/lib/noteIcons.ts)용 — 히스토리 노트 앱에 어울리는
  // 콘텐츠성 아이콘 세트. 기존 재사용(Note/Folder/Star/Doc/Timeline/Graph/Clock/Link/Image/
  // Palette/Lock/Mic)에 아래를 더한다.
  IconBook,
  IconScroll,
  IconSparkles,
  IconLandmark,
  IconCrown,
  IconMap,
  IconFlag,
  IconGlobe,
  IconInfo,
  IconSmartphone,
  IconSun,
  IconFeather,
  IconSwords,
  IconShield,
  IconNewspaper,
  IconHourglass,
  IconCompass,
  IconAnchor,
  IconShip,
  IconMountain,
  IconLeaf,
  IconFlame,
  IconRepeat,
  IconMoon,
  IconMusic,
  IconCamera,
  IconUsers,
  IconHeart,
  IconMail,
  IconBriefcase,
  IconScale,
  IconGraduation,
  IconBookmark,
  IconFlask,
  IconBuilding,
  IconSmile,
  IconPin,
  // 에디터 툴바 — wave 1: 하이라이트/밑줄/표 삽입. 텍스트 색상은 기존 IconPalette 재사용.
  IconHighlight,
  IconUnderline,
  IconTable,
  IconClearFormat,
  IconPaste,
  // Wave 2 — 에디터 선택 컨텍스트 메뉴(복사/잘라내기).
  IconCopy,
  // Home board card — unchecked-todo-count badge (dashboard QA cleanup): was a hardcoded "☐"
  // glyph. Square is already used above (aliased IconMaximize) — same reuse convention as
  // IconFocus/IconMaximize2 sharing Maximize2.
  IconCheckboxEmpty,
  // Icon convergence pass: pulls scattered hand-rolled inline <svg> icons (App.tsx, AiActionsMenu,
  // yearfilter/shared.tsx, mobile/**, etc.) onto this shared facade instead of each file keeping its
  // own copy. IconPin above (Pin, a thumbtack) already covers "always on top" style pinning —
  // MapPin is the separate teardrop-marker glyph used for geographic place badges/mode tabs.
  IconMapPin,
  IconTag,
  IconHistory,
  IconWrench,
  // AI menu's "produces body text" preset icon — was 3 horizontal lines (paragraph glyph); AlignLeft
  // is the closest lucide match for "summary/body text".
  IconSummary,
  IconArrowLeft,
  IconPaperclip,
  IconMoreHorizontal,
  IconCalendar,
  // Filter mode tab "Tree" icon — nested rows of a note hierarchy; ListTree is lucide's dedicated
  // hierarchy glyph (closer fit than a generic List).
  IconTree,
  // Sidebar filter-strip toggle (next to search) and chat view tab.
  IconFilter,
  IconFilter as IconListFilter,
  IconChat,
  // Workspace switcher's default (no user-picked icon) glyph — was a hand-drawn asymmetric grid
  // (square + header band + two-column footer). LayoutTemplate is the closest lucide silhouette for
  // an unset "layout" placeholder.
  IconWorkspace,
  IconWidget,
  IconLayoutGrid,
  IconShapes,
  IconGrid,
  IconWeather,
  IconActivity,
  IconCalendarDays,
  IconSort,
  // Home calendar day-cell forecast icons (lib/weather.ts::weatherCodeToIcon) — bucket boundaries
  // mirror weatherLabelKey exactly (icon derived from the same label key, see weather.ts).
  // Meteocons (MIT) SMIL-animated SVGs, not lucide — see assets/weather/icons.tsx for the actual
  // components/license; this file just re-exports under the same names so weather.ts and its
  // callers didn't need to change their imports.
  // Editor width toggle (comfortable ↔ full-width) — icon reflects the ACTION the click performs,
  // not the current state: comfortable mode shows "expand" (LeftRight), full-width shows "collapse"
  // (RightLeft), mirroring the codebase's existing focus/exit-focus icon-per-action convention
  // (IconFocus/IconExitFocus above).
  IconChevronsExpand,
  IconChevronsCollapse,
  // Table menu (compact row/column controls, BubbleMenu-style when the caret is inside a table) —
  // row insert-above/below reuse plain up/down arrows, column insert-left/right reuse the existing
  // IconArrowLeft (above) + a new right arrow. Delete-row/column reuse Rows3/Columns3 (tooltip
  // disambiguates from the whole-table delete, which is a separate danger-colored text button —
  // same icon-reuse convention already established by IconFocus/IconMaximize2 both wrapping
  // Maximize2).
  IconArrowUp,
  IconArrowDown,
  IconArrowRight,
  IconRowDelete,
  IconColumnDelete,
  IconHeaderRowToggle,
  // Footnote-create buttons (TextBubbleMenu/SelectionContextMenu) — used to reuse IconQuote
  // (blockquote glyph), confusable with real quote formatting though footnote creates a DB
  // attachment row. Asterisk is lucide's footnote-marker convention.
  IconAsterisk,
  // Settings help affordances (PetSection asset spec guide) — no existing help/question icon
  // in this file, CircleHelp is lucide's standard "?" glyph.
  IconHelp,
  // 관계도 다중 선택 정렬 도구 (FlowCanvas) — lucide's align-*-vertical family draws a VERTICAL
  // guide (left/centre/right), i.e. horizontal alignment; align-*-horizontal draws a HORIZONTAL
  // guide (top/middle/bottom). Named here for the alignment they perform, not for lucide's axis.
  IconAlignLeft,
  IconAlignCenterX,
  IconAlignRight,
  IconAlignTop,
  IconAlignCenterY,
  IconAlignBottom,
  IconDistributeX,
  IconDistributeY,
  // 관계도 PNG 내보내기 (FlowCanvas) — "이 그림을 파일로", distinct from IconImage (insert a picture).
  IconImageExport,
  IconArchive,
  IconKanban,
  IconWallet,
  IconSheet,
  IconChart,
  IconUndo,
  IconRedo,
  // 시트 툴바 전면 아이콘화 (SheetToolbar) — 라벨이 사라진 자리라 글리프가 서로 구분돼야 한다.
  // 서식 6종 중 date/checkbox 는 기존 IconCalendar/IconCheck 를 재사용하고, 나머지 4종만 새로.
  // 정렬 오름/내림은 예전에 둘 다 IconSort(arrow-up-down) 였다 — 라벨 없이는 같은 그림 두 개라
  // narrow-wide 쌍으로 나눈다. 행/열 삽입은 between-*-start(선택 위치에 끼워넣기), 삭제는 기존
  // IconRowDelete/IconColumnDelete 재사용(우클릭 메뉴와 같은 뜻).
  IconFmtText,
  IconFmtNumber,
  IconFmtCurrency,
  IconFmtPercent,
  IconDecimalMore,
  IconDecimalLess,
  IconRowInsert,
  IconColumnInsert,
  IconSortAsc,
  IconSortDesc,
  IconEraser,
  // 공간 탭 잉크 팔레트: 레이저 포인터(§5.5#3) — 커밋 안 하는 페이드 획.
  IconLaser,
  // 치트시트 제스처 칩 4종 (CheatsheetPopover RuleToken) — 위 import 주석 참고.
  IconMouse,
  IconMousePointerClick,
  IconMouseDoubleClick,
  IconGrab,
};

// Home weather icons (calendar day cells + header vignette) — Meteocons (MIT), not lucide. See
// the comment at the old IconWeatherSun-etc. import site above and assets/weather/icons.tsx.
export {
  IconWeatherSun,
  IconWeatherCloudSun,
  IconWeatherCloud,
  IconWeatherFog,
  IconWeatherRain,
  IconWeatherSnow,
  IconWeatherShowers,
  IconWeatherThunder,
} from '../assets/weather/icons';

// THE one AI mark (W7-b, docs/PLAN-2026-08-04-w7.md "AI 아이콘" — 13:1 다수결로 Sparkles 채택,
// 이 파일이 예전에 그리던 커스텀 별 모양은 폐기). AiActionsMenu 의 메뉴 트리거 안에서조차 이
// 아이콘과 lucide Sparkles 가 나란히 다르게 보이던 게 원래 문제였다 — 이제 AI 를 뜻하는 자리는
// 전부 이 컴포넌트 하나만 쓴다(13곳: ContextMenu/TabBar/SectionTabBar/SelectionContextMenu/
// PresetList/PreviewAttachment/AskAiModal/AiActionsMenu/모바일 2곳). `icon-ai-anim`(tokens.css
// ICON-ANIMATION) 을 여기서 한 번만 붙이므로 호출부는 신경 쓸 필요가 없다 — prefers-reduced-motion
// 은 그 CSS 쪽에서 처리(정지 이미지로 고정).
export function IconAi({ size = 16, strokeWidth = 1.8, className, ...rest }: IconProps) {
  return (
    <Sparkles
      size={size}
      strokeWidth={strokeWidth}
      className={className ? `icon-ai-anim ${className}` : "icon-ai-anim"}
      aria-hidden
      {...rest}
    />
  );
}

export type CaretDir = 'up' | 'down' | 'left' | 'right';

const CARET_ROTATE: Record<CaretDir, number> = { down: 0, left: 90, right: -90, up: 180 };

// Icon convergence pass: the single chevron for every expand/collapse toggle, dropdown trigger,
// and prev/next control (was IconChevron rotated ad hoc at 40+ call sites, plus separate
// IconChevronLeft/IconChevronRight elsewhere — 8 sizes and 5 stroke widths for the same glyph,
// user-reported: "방향만 달라야 하는데 굵기나 스타일이 다르다"). `dir` IS the direction the
// arrowhead visually points, so callers stop hand-picking rotate() transforms (which is exactly
// how the old call sites drifted into 3 incompatible conventions — RegionPreview.tsx used +90 for
// "open" where every other fold/unfold site used +90/-90 for "closed" and 0/180 for "open").
// strokeWidth is fixed at 2 — both the most common explicit value across the old call sites and
// lucide's own default (so every call site that left strokeWidth unset was already a de facto 2)
// — and left out of the prop type entirely so callers can't reintroduce the drift. size stays
// caller-controlled to fit surrounding UI density (11px in dense rows up to 17px in mobile lists).
export function IconCaret({
  dir,
  size = 14,
  className,
  style,
  ...rest
}: Omit<IconProps, 'strokeWidth'> & { dir: CaretDir }) {
  return (
    <IconChevron
      size={size}
      strokeWidth={2}
      className={className}
      style={{
        transform: `rotate(${CARET_ROTATE[dir]}deg)`,
        transition: "transform var(--dur-fast) ease-out",
        ...style,
      }}
      aria-hidden
      {...rest}
    />
  );
}
