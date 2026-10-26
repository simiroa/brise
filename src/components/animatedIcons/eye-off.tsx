// 생성물: lucide-animated(MIT) 'eye-off' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 eye-off 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const PATH_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
  animate: {
    pathLength: [0, 2],
    opacity: [0, 1],
    pathOffset: [0, 2],
    transition: { duration: 0.6 },
  },
};

const EyeOffIcon = createAnimatedIcon(
  'eye-off',
  {  },
  <>
    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
          <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
          <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
          <motion.path
            d="m2 2 20 20"
            variants={PATH_VARIANTS}
          />
  </>,
);

export default EyeOffIcon;
