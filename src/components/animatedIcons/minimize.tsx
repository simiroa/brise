// 생성물: lucide-animated(MIT) 'minimize' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 주의: 기하가 lucide-react 와 다르다(옛 글리프) — 오너 승인으로 의도적으로 교체(2026-10-13, 프레임 아이콘).
import { motion, type Transition } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const DEFAULT_TRANSITION: Transition = {
  type: "spring",
  stiffness: 250,
  damping: 25,
};

const MinimizeIcon = createAnimatedIcon(
  'minimize',
  {  },
  <>
    <motion.path
            d="M8 3v3a2 2 0 0 1-2 2H3"
            transition={DEFAULT_TRANSITION}
            variants={{
              normal: { translateX: "0%", translateY: "0%" },
              animate: { translateX: "2px", translateY: "2px" },
            }}
          />
          <motion.path
            d="M21 8h-3a2 2 0 0 1-2-2V3"
            transition={DEFAULT_TRANSITION}
            variants={{
              normal: { translateX: "0%", translateY: "0%" },
              animate: { translateX: "-2px", translateY: "2px" },
            }}
          />
          <motion.path
            d="M3 16h3a2 2 0 0 1 2 2v3"
            transition={DEFAULT_TRANSITION}
            variants={{
              normal: { translateX: "0%", translateY: "0%" },
              animate: { translateX: "2px", translateY: "-2px" },
            }}
          />
          <motion.path
            d="M16 21v-3a2 2 0 0 1 2-2h3"
            transition={DEFAULT_TRANSITION}
            variants={{
              normal: { translateX: "0%", translateY: "0%" },
              animate: { translateX: "-2px", translateY: "-2px" },
            }}
          />
  </>,
);

export default MinimizeIcon;
