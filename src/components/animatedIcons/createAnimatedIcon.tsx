// lucide-animated(https://lucide-animated.com, MIT — LICENSE.md 참고)의 아이콘을 이 앱의 아이콘 계약에
// 맞춰 올리는 공장. 원본은 아이콘마다 useAnimation/useImperativeHandle/마우스 핸들러 약 60줄을 복붙하고
// 아이콘을 <div> 로 감싸는데(<button> 안의 div 는 무효 마크업이고 `.icon-btn > svg` 레이아웃도 깬다),
// 여기서는 그 뼈대를 한 번만 두고 아이콘 파일에는 경로·variants 만 남긴다.
//  · svg 를 직접 렌더 — IconProps(size/strokeWidth/className/style/aria-*) 그대로 받는다.
//  · 트리거는 hoverHost.ts 의 위임 리스너(부모 버튼/행에 hover).
//  · lucide 와 같은 클래스(`lucide lucide-<이름>`)를 달고 `data-anim` 으로 CSS 폴백(tokens.css)과 구분.
import { forwardRef, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { motion, useAnimation, type Transition, type Variants } from 'motion/react';
import type { IconProps } from '../icons';
import { registerHoverIcon } from './hoverHost';

interface SvgMotion {
  initial?: string | boolean;
  variants?: Variants;
  transition?: Transition;
}

export function createAnimatedIcon(name: string, svg: SvgMotion, body: ReactNode) {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function AnimatedIcon(
    { size = 24, strokeWidth = 2, className, ...rest },
    ref,
  ) {
    const controls = useAnimation();
    const local = useRef<SVGSVGElement | null>(null);
    const setRef = useCallback(
      (el: SVGSVGElement | null) => {
        local.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      },
      [ref],
    );
    useEffect(() => {
      const el = local.current;
      if (!el) return;
      return registerHoverIcon(el, {
        start: () => void controls.start('animate'),
        stop: () => void controls.start('normal'),
      });
    }, [controls]);
    const cls = `lucide lucide-${name}${className ? ` ${className}` : ''}`;
    return (
      <motion.svg
        ref={setRef}
        data-anim=""
        className={cls}
        animate={controls}
        initial={svg.initial}
        variants={svg.variants}
        transition={svg.transition}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        xmlns="http://www.w3.org/2000/svg"
        // motion.svg 의 이벤트 핸들러 타입이 SVGProps 와 달라 나머지 속성은 통과시킨다.
        {...(rest as object)}
      >
        {body}
      </motion.svg>
    );
  });
  Icon.displayName = `Animated(${name})`;
  return Icon;
}
