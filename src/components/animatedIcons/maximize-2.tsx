// 생성물: lucide-animated(MIT) 'maximize-2' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 주의: 기하가 lucide-react 와 다르다(옛 글리프) — 오너 승인으로 의도적으로 교체(2026-10-13, 프레임 아이콘).
import { motion, type Transition } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const DEFAULT_TRANSITION: Transition = {
  type: "spring",
  stiffness: 250,
  damping: 25,
};

const Maximize2Icon = createAnimatedIcon(
  'maximize-2',
  {  },
  <>
    <motion.path
            d="M3 16.2V21m0 0h4.8M3 21l6-6"
            transition={DEFAULT_TRANSITION}
            variants={{
              normal: { translateX: "0%", translateY: "0%" },
              animate: { translateX: "-2px", translateY: "2px" },
            }}
          />
          <motion.path
            d="M21 7.8V3m0 0h-4.8M21 3l-6 6"
            transition={DEFAULT_TRANSITION}
            variants={{
              normal: { translateX: "0%", translateY: "0%" },
              animate: { translateX: "2px", translateY: "-2px" },
            }}
          />
  </>,
);

export default Maximize2Icon;
