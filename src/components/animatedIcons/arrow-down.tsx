// 생성물: lucide-animated(MIT) 'arrow-down' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 arrow-down 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const PATH_VARIANTS: Variants = {
  normal: { d: "m19 12-7 7-7-7", translateY: 0 },
  animate: {
    d: "m19 12-7 7-7-7",
    translateY: [0, -3, 0],
    transition: {
      duration: 0.4,
    },
  },
};

const SECOND_PATH_VARIANTS: Variants = {
  normal: { d: "M12 5v14" },
  animate: {
    d: ["M12 5v14", "M12 5v9", "M12 5v14"],
    transition: {
      duration: 0.4,
    },
  },
};

const ArrowDownIcon = createAnimatedIcon(
  'arrow-down',
  {  },
  <>
    <motion.path
            d="m19 12-7 7-7-7"
            variants={PATH_VARIANTS}
          />
          <motion.path
            d="M12 5v14"
            variants={SECOND_PATH_VARIANTS}
          />
  </>,
);

export default ArrowDownIcon;
