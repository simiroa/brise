// 생성물: lucide-animated(MIT) 'arrow-left' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 arrow-left 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const PATH_VARIANTS: Variants = {
  normal: { d: "m12 19-7-7 7-7", translateX: 0 },
  animate: {
    d: "m12 19-7-7 7-7",
    translateX: [0, 3, 0],
    transition: {
      duration: 0.4,
    },
  },
};

const SECOND_PATH_VARIANTS: Variants = {
  normal: { d: "M19 12H5" },
  animate: {
    d: ["M19 12H5", "M19 12H10", "M19 12H5"],
    transition: {
      duration: 0.4,
    },
  },
};

const ArrowLeftIcon = createAnimatedIcon(
  'arrow-left',
  {  },
  <>
    <motion.path
            d="m12 19-7-7 7-7"
            variants={PATH_VARIANTS}
          />
          <motion.path
            d="M19 12H5"
            variants={SECOND_PATH_VARIANTS}
          />
  </>,
);

export default ArrowLeftIcon;
