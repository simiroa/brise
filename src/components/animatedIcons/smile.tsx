// 생성물: lucide-animated(MIT) 'smile' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 smile 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).
import { motion, type Variants } from 'motion/react';
import { createAnimatedIcon } from './createAnimatedIcon';



const faceVariants: Variants = {
      normal: {
        scale: 1,
        rotate: 0,
        strokeWidth: 2,
        transition: { duration: 0.3, ease: "easeOut" },
      },
      animate: {
        scale: [1, 1.15, 1.05, 1.1],
        rotate: [0, -3, 3, 0],
        strokeWidth: [2, 2.5, 2.5, 2.5],
        transition: {
          duration: 0.8,
          times: [0, 0.3, 0.6, 1],
          ease: "easeInOut",
        },
      },
    };

const mouthVariants: Variants = {
      normal: {
        d: "M8 14s1.5 2 4 2 4-2 4-2",
        pathLength: 1,
        pathOffset: 0,
        strokeWidth: 2,
        transition: { duration: 0.3, ease: "easeOut" },
      },
      animate: {
        d: "M7 13.5s2.5 3.5 5 3.5 5-3.5 5-3.5",
        pathLength: [0.3, 1, 1],
        pathOffset: [0, 0, 0],
        strokeWidth: 2.5,
        transition: {
          d: { duration: 0.4, ease: "easeOut" },
          pathLength: {
            duration: 0.5,
            times: [0, 0.5, 1],
            ease: "easeInOut",
          },
          delay: 0.1,
        },
      },
    };

const eyeVariants: Variants = {
      normal: {
        scale: 1,
        opacity: 1,
        transition: { duration: 0.3, ease: "easeOut" },
      },
      animate: {
        scale: [1, 1.5, 0.8, 1.2],
        opacity: [1, 1, 1, 1],
        transition: {
          duration: 0.5,
          times: [0, 0.3, 0.6, 1],
          ease: "easeInOut",
        },
      },
    };

const SmileIcon = createAnimatedIcon(
  'smile',
  { initial: "normal", variants: faceVariants },
  <>
    <motion.circle cx="12" cy="12" r="10" />
          <motion.path
            d="M8 14s1.5 2 4 2 4-2 4-2"
            initial="normal"
            variants={mouthVariants}
          />
          <motion.line
            initial="normal"
            variants={eyeVariants}
            x1="9"
            x2="9.01"
            y1="9"
            y2="9"
          />
          <motion.line
            initial="normal"
            variants={eyeVariants}
            x1="15"
            x2="15.01"
            y1="9"
            y2="9"
          />
  </>,
);

export default SmileIcon;
