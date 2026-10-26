/**
 * BriSe Modern Vector Weather Icons with Sleek Micro-Animations
 *
 * Replaces heavy cartoonish filled icons with crisp 1.8px line-art vectors
 * perfectly conforming to BriSe's Lucide stroke aesthetic and color tokens.
 *
 * Micro-animations are pure CSS, GPU-accelerated, lightweight, and automatically
 * disabled when `prefers-reduced-motion: reduce` is active.
 */
import type { IconProps } from "../../components/icons";

export function IconWeatherSun({ size = 24, strokeWidth = 1.8, className = "", style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`wx-icon wx-sun ${className}`}
      style={style}
      {...props}
    >
      <circle cx="12" cy="12" r="4" className="wx-sun__core" />
      <g className="wx-sun__rays">
        <line x1="12" y1="2" x2="12" y2="4" />
        <line x1="12" y1="20" x2="12" y2="22" />
        <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
        <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
        <line x1="2" y1="12" x2="4" y2="12" />
        <line x1="20" y1="12" x2="22" y2="12" />
        <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
        <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
      </g>
    </svg>
  );
}

export function IconWeatherCloudSun({ size = 24, strokeWidth = 1.8, className = "", style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`wx-icon wx-cloud-sun ${className}`}
      style={style}
      {...props}
    >
      <g className="wx-sun-behind">
        <path d="M12 2v2" />
        <path d="m4.93 4.93 1.41 1.41" />
        <path d="M20 12h2" />
        <path d="m19.07 4.93-1.41 1.41" />
        <path d="M15.95 7.05a4 4 0 0 0-5.9 3.45" />
      </g>
      <path
        className="wx-cloud-front"
        d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"
      />
    </svg>
  );
}

export function IconWeatherCloud({ size = 24, strokeWidth = 1.8, className = "", style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`wx-icon wx-cloud ${className}`}
      style={style}
      {...props}
    >
      <path
        className="wx-cloud-body"
        d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"
      />
    </svg>
  );
}

export function IconWeatherFog({ size = 24, strokeWidth = 1.8, className = "", style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`wx-icon wx-fog ${className}`}
      style={style}
      {...props}
    >
      <path className="wx-cloud-body" d="M17.5 15H9a5 5 0 0 1 4.8-4.95A4 4 0 0 1 20 12a3.5 3.5 0 0 1-2.5 3Z" />
      <line x1="4" y1="18" x2="20" y2="18" className="wx-fog-line wx-fog-1" />
      <line x1="6" y1="21" x2="18" y2="21" className="wx-fog-line wx-fog-2" />
    </svg>
  );
}

export function IconWeatherRain({ size = 24, strokeWidth = 1.8, className = "", style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`wx-icon wx-rain ${className}`}
      style={style}
      {...props}
    >
      <path className="wx-cloud-body" d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <line x1="8" y1="14" x2="7" y2="18" className="wx-drop wx-drop-1" />
      <line x1="12" y1="14" x2="11" y2="18" className="wx-drop wx-drop-2" />
      <line x1="16" y1="14" x2="15" y2="18" className="wx-drop wx-drop-3" />
    </svg>
  );
}

export function IconWeatherShowers({ size = 24, strokeWidth = 1.8, className = "", style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`wx-icon wx-showers ${className}`}
      style={style}
      {...props}
    >
      <path className="wx-cloud-body" d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <line x1="8" y1="13" x2="6" y2="19" className="wx-drop wx-heavy-1" />
      <line x1="12" y1="13" x2="10" y2="19" className="wx-drop wx-heavy-2" />
      <line x1="16" y1="13" x2="14" y2="19" className="wx-drop wx-heavy-3" />
    </svg>
  );
}

export function IconWeatherSnow({ size = 24, strokeWidth = 1.8, className = "", style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`wx-icon wx-snow ${className}`}
      style={style}
      {...props}
    >
      <path className="wx-cloud-body" d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M8 15h.01" className="wx-flake wx-flake-1" strokeWidth={2.4} />
      <path d="M12 17h.01" className="wx-flake wx-flake-2" strokeWidth={2.4} />
      <path d="M16 15h.01" className="wx-flake wx-flake-3" strokeWidth={2.4} />
      <path d="M10 19h.01" className="wx-flake wx-flake-4" strokeWidth={2.4} />
      <path d="M14 19h.01" className="wx-flake wx-flake-5" strokeWidth={2.4} />
    </svg>
  );
}

export function IconWeatherThunder({ size = 24, strokeWidth = 1.8, className = "", style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`wx-icon wx-thunder ${className}`}
      style={style}
      {...props}
    >
      <path className="wx-cloud-body" d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
      <polyline points="13 10 11 15 14 15 12 20" className="wx-bolt" />
    </svg>
  );
}
