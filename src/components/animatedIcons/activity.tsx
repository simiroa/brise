// 생성물: lucide-animated(MIT) 'activity' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 activity 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    pathOffset: 0,
    transition: {
      duration: 0.4,
      opacity: { duration: 0.1 },
    },
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [1, 0],
    transition: {
      duration: 0.6,
      ease: "linear",
      opacity: { duration: 0.1 },
    },
  },
};

const ActivityIcon = createAnimatedIcon(
  'activity',
  {  },
  <>
    <motion.path
            d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"
            initial="normal"
            variants={VARIANTS}
          />
  </>,
);

export default ActivityIcon;
