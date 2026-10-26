// 생성물: lucide-animated(MIT) 'hourglass' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 hourglass 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';



const HourglassIcon = createAnimatedIcon(
  'hourglass',
  {  },
  <>
    <motion.g
            style={{
              transformOrigin: "12px 12px",
            }}
            transition={{
              type: "spring",
              stiffness: 100,
              damping: 15,
              mass: 1,
            }}
            variants={{
              normal: {
                rotate: 0,
              },
              animate: {
                rotate: 180,
              },
            }}
          >
            <path d="M5 22h14" />
            <path d="M5 2h14" />
            <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
            <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
          </motion.g>
  </>,
);

export default HourglassIcon;
