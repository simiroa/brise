import type { ComponentType } from "react";
import type { IconProps } from "../components/icons";
import {
  IconNote,
  IconBook,
  IconScroll,
  IconLandmark,
  IconCrown,
  IconSwords,
  IconShield,
  IconFlag,
  IconMap,
  IconGlobe,
  IconFeather,
  IconStar,
  IconFolder,
  IconClock,
  IconTimeline,
  IconGraph,
  IconImage,
  IconLink,
  IconLock,
  IconPalette,
  IconCalendar,
  IconMapPin,
  IconHistory,
  IconHome,
  IconMic,
  IconTag,
  IconQuote,
  IconNewspaper,
  IconHourglass,
  IconCompass,
  IconAnchor,
  IconShip,
  IconMountain,
  IconLeaf,
  IconFlame,
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
} from "../components/icons";

export interface NoteIconDef {
  key: string;
  Comp: ComponentType<IconProps>;
}

// 큐레이션된 콘텐츠 아이콘 팔레트 — 워크스페이스(노트 모음의 정체성)와 노트 행에서 공용으로
// 쓴다. 편집툴바/창버튼 같은 UI 크롬 아이콘은 일부러 제외하고, 역사 노트 앱에 어울리는
// "주제/내용"성 아이콘만 골랐다. DB에는 여기 key 문자열만 저장한다(NULL = 기본 아이콘).
export const NOTE_ICONS: NoteIconDef[] = [
  { key: "note", Comp: IconNote },
  { key: "book", Comp: IconBook },
  { key: "scroll", Comp: IconScroll },
  { key: "landmark", Comp: IconLandmark },
  { key: "crown", Comp: IconCrown },
  { key: "swords", Comp: IconSwords },
  { key: "shield", Comp: IconShield },
  { key: "flag", Comp: IconFlag },
  { key: "map", Comp: IconMap },
  { key: "globe", Comp: IconGlobe },
  { key: "feather", Comp: IconFeather },
  { key: "star", Comp: IconStar },
  { key: "folder", Comp: IconFolder },
  { key: "clock", Comp: IconClock },
  { key: "timeline", Comp: IconTimeline },
  { key: "graph", Comp: IconGraph },
  { key: "image", Comp: IconImage },
  { key: "link", Comp: IconLink },
  { key: "lock", Comp: IconLock },
  { key: "palette", Comp: IconPalette },
  { key: "calendar", Comp: IconCalendar },
  { key: "place", Comp: IconMapPin },
  { key: "history", Comp: IconHistory },
  { key: "home", Comp: IconHome },
  { key: "mic", Comp: IconMic },
  { key: "tag", Comp: IconTag },
  { key: "quote", Comp: IconQuote },
  { key: "newspaper", Comp: IconNewspaper },
  { key: "hourglass", Comp: IconHourglass },
  { key: "compass", Comp: IconCompass },
  { key: "anchor", Comp: IconAnchor },
  { key: "ship", Comp: IconShip },
  { key: "mountain", Comp: IconMountain },
  { key: "leaf", Comp: IconLeaf },
  { key: "flame", Comp: IconFlame },
  { key: "moon", Comp: IconMoon },
  { key: "music", Comp: IconMusic },
  { key: "camera", Comp: IconCamera },
  { key: "users", Comp: IconUsers },
  { key: "heart", Comp: IconHeart },
  { key: "mail", Comp: IconMail },
  { key: "briefcase", Comp: IconBriefcase },
  { key: "scale", Comp: IconScale },
  { key: "graduation", Comp: IconGraduation },
  { key: "bookmark", Comp: IconBookmark },
  { key: "flask", Comp: IconFlask },
  { key: "building", Comp: IconBuilding },
];

const BY_KEY = new Map(NOTE_ICONS.map((d) => [d.key, d.Comp]));

/** 아이콘 키 → 컴포넌트. 미지정(null)/미지의 키면 fallback 을 돌려준다(안전한 폴백). */
export function noteIconComp(
  key: string | null | undefined,
  fallback: ComponentType<IconProps>
): ComponentType<IconProps> {
  if (!key) return fallback;
  return BY_KEY.get(key) ?? fallback;
}
