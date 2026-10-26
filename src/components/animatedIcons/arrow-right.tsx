// 생성물: lucide-animated(MIT) 'arrow-right' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 arrow-right 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const PATH_VARIANTS: Variants = {
  normal: { d: "M5 12h14" },
  animate: {
    d: ["M5 12h14", "M5 12h9", "M5 12h14"],
    transition: {
      duration: 0.4,
    },
  },
};

const SECONDARY_PATH_VARIANTS: Variants = {
  normal: { d: "m12 5 7 7-7 7", translateX: 0 },
  animate: {
    d: "m12 5 7 7-7 7",
    translateX: [0, -3, 0],
    transition: {
      duration: 0.4,
    },
  },
};

const ArrowRightIcon = createAnimatedIcon(
  'arrow-right',
  {  },
  <>
    <motion.path
            d="M5 12h14"
            variants={PATH_VARIANTS}
          />
          <motion.path
            d="m12 5 7 7-7 7"
            variants={SECONDARY_PATH_VARIANTS}
          />
  </>,
);

export default ArrowRightIcon;
