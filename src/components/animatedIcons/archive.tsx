// 생성물: lucide-animated(MIT) 'archive' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 archive 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const RECT_VARIANTS: Variants = {
  normal: {
    translateY: 0,
    transition: {
      duration: 0.2,
      type: "spring",
      stiffness: 200,
      damping: 25,
    },
  },
  animate: {
    translateY: -1.5,
    transition: {
      duration: 0.2,
      type: "spring",
      stiffness: 200,
      damping: 25,
    },
  },
};

const PATH_VARIANTS: Variants = {
  normal: { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" },
  animate: { d: "M4 11v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V11" },
};

const SECONDARY_PATH_VARIANTS: Variants = {
  normal: { d: "M10 12h4" },
  animate: { d: "M10 15h4" },
};

const ArchiveIcon = createAnimatedIcon(
  'archive',
  {  },
  <>
    <motion.rect
            height="5"
            initial="normal"
            rx="1"
            variants={RECT_VARIANTS}
            width="20"
            x="2"
            y="3"
          />
          <motion.path
            d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"
            variants={PATH_VARIANTS}
          />
          <motion.path
            d="M10 12h4"
            variants={SECONDARY_PATH_VARIANTS}
          />
  </>,
);

export default ArchiveIcon;
