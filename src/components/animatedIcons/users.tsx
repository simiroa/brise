// 생성물: lucide-animated(MIT) 'users' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 users 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const PATH_VARIANTS: Variants = {
  normal: {
    translateX: 0,
    transition: {
      type: "spring",
      stiffness: 200,
      damping: 13,
    },
  },
  animate: {
    translateX: [-6, 0],
    transition: {
      delay: 0.1,
      type: "spring",
      stiffness: 200,
      damping: 13,
    },
  },
};

const UsersIcon = createAnimatedIcon(
  'users',
  {  },
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <motion.path
            d="M22 21v-2a4 4 0 0 0-3-3.87"
            variants={PATH_VARIANTS}
          />
          <motion.path
            d="M16 3.13a4 4 0 0 1 0 7.75"
            variants={PATH_VARIANTS}
          />
  </>,
);

export default UsersIcon;
