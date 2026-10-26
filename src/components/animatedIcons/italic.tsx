// 생성물: lucide-animated(MIT) 'italic' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 italic 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const LINE_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    pathOffset: [1, 0],
  },
};

const ItalicIcon = createAnimatedIcon(
  'italic',
  {  },
  <>
    <motion.line
            transition={{ duration: 0.2 }}
            variants={LINE_VARIANTS}
            x1="19"
            x2="10"
            y1="4"
            y2="4"
          />
          <motion.line
            transition={{ duration: 0.2 }}
            variants={LINE_VARIANTS}
            x1="14"
            x2="5"
            y1="20"
            y2="20"
          />
          <motion.line
            transition={{
              delay: 0.1,
              duration: 0.4,
            }}
            variants={{
              normal: { pathLength: 1, pathOffset: 0 },
              animate: {
                pathLength: [0, 1],
                pathOffset: [1, 0],
              },
            }}
            x1="15"
            x2="9"
            y1="4"
            y2="20"
          />
  </>,
);

export default ItalicIcon;
