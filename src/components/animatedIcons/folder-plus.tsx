// 생성물: lucide-animated(MIT) 'folder-plus' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 folder-plus 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const PATH_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      duration: 0.4,
      ease: "easeInOut",
      delay: custom * 0.1,
      opacity: { delay: custom * 0.1 },
    },
  }),
};

const FolderPlusIcon = createAnimatedIcon(
  'folder-plus',
  {  },
  <>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          <motion.path
            custom={1}
            d="M12 10v6"
            initial="normal"
            variants={PATH_VARIANTS}
          />
          <motion.path
            custom={0}
            d="M9 13h6"
            initial="normal"
            variants={PATH_VARIANTS}
          />
  </>,
);

export default FolderPlusIcon;
