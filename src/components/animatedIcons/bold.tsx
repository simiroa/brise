// 생성물: lucide-animated(MIT) 'bold' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 bold 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const PATH_VARIANTS: Variants = {
  normal: {
    strokeWidth: 2,
  },
  animate: {
    strokeWidth: 3.5,
  },
};

const BoldIcon = createAnimatedIcon(
  'bold',
  {  },
  <>
    <motion.path
            d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"
            transition={{ duration: 0.6 }}
            variants={PATH_VARIANTS}
          />
  </>,
);

export default BoldIcon;
