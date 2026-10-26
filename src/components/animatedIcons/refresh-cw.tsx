// 생성물: lucide-animated(MIT) 'refresh-cw' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 refresh-cw 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).

import { createAnimatedIcon } from './createAnimatedIcon';



const RefreshCwIcon = createAnimatedIcon(
  'refresh-cw',
  { variants: {
            normal: { rotate: "0deg" },
            animate: { rotate: "50deg" },
          }, transition: { type: "spring", stiffness: 250, damping: 25 } },
  <>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
  </>,
);

export default RefreshCwIcon;
