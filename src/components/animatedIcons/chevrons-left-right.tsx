// 생성물: lucide-animated(MIT) 'chevrons-left-right' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 chevrons-left-right 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Transition } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const DEFAULT_TRANSITION: Transition = {
  type: "spring",
  stiffness: 250,
  damping: 25,
};

const ChevronsLeftRightIcon = createAnimatedIcon(
  'chevrons-left-right',
  {  },
  <>
    <motion.path
          d="m9 7-5 5 5 5"
          initial="normal"
          transition={DEFAULT_TRANSITION}
          variants={{
            normal: { translateX: "0%" },
            animate: { translateX: "-2px" },
          }}
        />
        <motion.path
          d="m15 7 5 5-5 5"
          initial="normal"
          transition={DEFAULT_TRANSITION}
          variants={{
            normal: { translateX: "0%" },
            animate: { translateX: "2px" },
          }}
        />
  </>,
);

export default ChevronsLeftRightIcon;
