import type { ComponentType } from "react";
import type { IconProps } from "../components/icons";
import { weatherCodeToVisual, weatherLabelKey } from "../lib/weather";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Cloud from "lucide-react/dist/esm/icons/cloud.mjs";
import CloudSun from "lucide-react/dist/esm/icons/cloud-sun.mjs";
import CloudMoon from "lucide-react/dist/esm/icons/cloud-moon.mjs";
import CloudRain from "lucide-react/dist/esm/icons/cloud-rain.mjs";
import CloudDrizzle from "lucide-react/dist/esm/icons/cloud-drizzle.mjs";
import CloudRainWind from "lucide-react/dist/esm/icons/cloud-rain-wind.mjs";
import CloudSunRain from "lucide-react/dist/esm/icons/cloud-sun-rain.mjs";
import CloudMoonRain from "lucide-react/dist/esm/icons/cloud-moon-rain.mjs";
import CloudSnow from "lucide-react/dist/esm/icons/cloud-snow.mjs";
import CloudHail from "lucide-react/dist/esm/icons/cloud-hail.mjs";
import CloudLightning from "lucide-react/dist/esm/icons/cloud-lightning.mjs";
import CloudFog from "lucide-react/dist/esm/icons/cloud-fog.mjs";
import Snowflake from "lucide-react/dist/esm/icons/snowflake.mjs";

export const WX_ICONS = {
  Sun, Moon, Cloud, CloudSun, CloudMoon, CloudRain, CloudDrizzle, CloudRainWind,
  CloudSunRain, CloudMoonRain, CloudSnow, CloudHail, CloudLightning, CloudFog, Snowflake,
} as const;

export interface WeatherVisual {
  Icon: ComponentType<IconProps>;
  colorVar: string;
  labelKey: string;
}

function iconFor(code: number, night: boolean): ComponentType<IconProps> {
  if (code === 0) return night ? Moon : Sun;
  if (code === 1 || code === 2) return night ? CloudMoon : CloudSun;
  if (code === 45 || code === 48) return CloudFog;
  if (code >= 51 && code <= 57) return CloudDrizzle;
  if (code === 65) return CloudRainWind;
  if (code === 66 || code === 67) return CloudHail;
  if (code >= 61 && code <= 64) return CloudRain;
  if (code === 73 || code === 75 || code === 77) return Snowflake;
  if (code >= 71 && code <= 77) return CloudSnow;
  if (code >= 80 && code <= 82) return night ? CloudMoonRain : CloudSunRain;
  if (code === 85 || code === 86) return CloudSnow;
  if (code >= 95 && code <= 99) return CloudLightning;
  return Cloud; // 3(흐림)·미지 코드
}

/** WMO 코드 × 낮/밤 → 아이콘·색(기존 weatherCodeToVisual 규칙 재사용)·라벨 키. */
export function weatherVisual(code: number, isNight = false, tempMaxC?: number): WeatherVisual {
  return { Icon: iconFor(code, isNight), colorVar: weatherCodeToVisual(code, tempMaxC).colorVar, labelKey: weatherLabelKey(code) };
}

/** 분(0..1439) 기준 밤 여부. 일출/일몰(분)이 없으면 6~18시를 낮으로 가정. */
export function isNightAt(minute: number, sunriseMin?: number | null, sunsetMin?: number | null): boolean {
  const rise = sunriseMin ?? 360;
  const set = sunsetMin ?? 1080;
  return minute < rise || minute >= set;
}
