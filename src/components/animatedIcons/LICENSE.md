# lucide-animated

이 폴더의 아이콘 파일(`*.tsx`, `createAnimatedIcon.tsx` 제외)은 lucide-animated (https://lucide-animated.com,
https://github.com/pqoqubbw/icons) 의 애니메이션 정의를 옮긴 것이다. MIT License.

Copyright (c) pqoqubbw (dmytro) and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.

## 이 앱에서 지키는 규칙

- 아이콘 기하(path d 등)가 lucide-react 와 같을 때만 교체한다. 레지스트리는 옛 글리프를 쓰는 경우가 있다
  (bell·settings·check·heart·moon 등은 모양이 달라 교체하지 않았다).
- 뼈대(훅·트리거)는 `createAnimatedIcon.tsx` 한 곳, 트리거는 `hoverHost.ts` 의 위임 리스너 하나.
- `chevron-down`(IconCaret 의 인라인 transform)과 `sparkles`(IconAi 상시 발광)는 제외.
