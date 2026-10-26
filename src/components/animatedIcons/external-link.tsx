// 생성물: lucide-animated(MIT) 'external-link' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 external-link 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const ARROW_VARIANTS: Variants = {
  normal: {
    scale: 1,
    translateX: 0,
    translateY: 0,
  },
  animate: {
    scale: [1, 0.92, 1],
    translateX: [0, 2, 0],
    translateY: [0, -2, 0],
    originX: 1,
    originY: 0,
    transition: {
      duration: 0.5,
      ease: "easeInOut",
    },
  },
};

const ExternalLinkIcon = createAnimatedIcon(
  'external-link',
  {  },
  <>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <motion.g variants={ARROW_VARIANTS}>
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
        </motion.g>
  </>,
);

export default ExternalLinkIcon;
