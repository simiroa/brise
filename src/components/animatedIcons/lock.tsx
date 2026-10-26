// 생성물: lucide-animated(MIT) 'lock' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 lock 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';



const LockIcon = createAnimatedIcon(
  'lock',
  { initial: "normal", variants: {
            normal: {
              rotate: 0,
              scale: 1,
            },
            animate: {
              rotate: [-3, 1, -2, 0],
              scale: [0.95, 1.05, 0.98, 1],
            },
          }, transition: {
            duration: 1,
            ease: [0.4, 0, 0.2, 1],
          } },
  <>
    <rect height="11" rx="2" ry="2" width="18" x="3" y="11" />
          <motion.path
            d="M7 11V7a5 5 0 0 1 10 0v4"
            initial="normal"
            transition={{
              duration: 0.3,
              ease: [0.4, 0, 0.2, 1],
            }}
            variants={{
              normal: {
                pathLength: 1,
              },
              animate: {
                pathLength: 0.7,
              },
            }}
          />
  </>,
);

export default LockIcon;
