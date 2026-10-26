// 생성물: lucide-animated(MIT) 'search' — 경로·애니메이션만 남기고 뼈대는 createAnimatedIcon 이 맡는다.
// 재생성: 아이콘 search 의 기하(path d 등)가 lucide-react 와 달라지면 교체하지 말 것(docs/DESIGN.md 아이콘 절).

import { createAnimatedIcon } from './createAnimatedIcon';



const SearchIcon = createAnimatedIcon(
  'search',
  { variants: {
            normal: { x: 0, y: 0 },
            animate: {
              x: [0, 0, -3, 0],
              y: [0, -4, 0, 0],
            },
          }, transition: {
            duration: 1,
            bounce: 0.3,
          } },
  <>
    <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
  </>,
);

export default SearchIcon;
