// 생성물: lucide-animated(MIT) 'feather' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 feather 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';

const FEATHER_VARIANTS: Variants = {
  normal: {
    rotate: 0,
    y: 0,
    x: 0,
  },
  animate: {
    rotate: [0, -8, 4, -3, 0],
    y: [0, -4, -2, -1, 0],
    x: [0, 2, -2, 1, 0],
    transition: {
      duration: 1.6,
      ease: "easeInOut",
    },
  },
};

const FeatherIcon = createAnimatedIcon(
  'feather',
  { variants: FEATHER_VARIANTS },
  <>
    <path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z" />
          <path d="M16 8 2 22" />
          <path d="M17.5 15H9" />
  </>,
);

export default FeatherIcon;
