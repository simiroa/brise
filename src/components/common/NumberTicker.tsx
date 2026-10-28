/**
 * 숫자가 바뀔 때 자릿수가 세로로 굴러가는 표시. 대시보드·패널의 개수/통계가 갑자기 "툭" 바뀌는 대신
 * 변화가 눈에 들어오게 한다. 숫자 모양은 Intl 이 정한다(천 단위·소수점이 로케일을 따른다).
 *
 * 접근성: 굴러가는 기둥은 aria-hidden 이고, 스크린리더에는 완성된 숫자 한 덩어리(aria-label)만 읽힌다.
 * 첫 렌더는 애니메이션 없이 그 값으로 선다 — 처음 보이는 숫자가 0 에서 올라오지 않는다.
 * 대시보드 보드 열의 개수가 쓴다.
 * ponytail: 자릿수가 늘면 새 앞자리 기둥은 굴러 들어오지 않고 그 값으로 바로 선다(마운트는 전환을 일으키지 않는다).
 */
import { useEffect, useState } from "react";
import "./uiKit.css";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function Digit({ d, animate }: { d: number; animate: boolean }) {
  return (
    <span className="ticker__digit" aria-hidden>
      <span
        className="ticker__col"
        style={{
          transform: `translateY(${-d}em)`,
          ...(animate ? null : { transition: "none" }),
        }}
      >
        {DIGITS.map((n) => (
          <span key={n}>{n}</span>
        ))}
      </span>
    </span>
  );
}

export function NumberTicker({
  value,
  locale,
  options,
}: {
  value: number;
  /** 지정하지 않으면 실행 환경 기본 로케일. 앱 UI 언어를 쓰려면 호출자가 넘긴다. */
  locale?: string;
  options?: Intl.NumberFormatOptions;
}) {
  // 첫 페인트 전에는 애니메이션을 켜지 않는다(마운트 직후 한 번 거쳐 간 뒤 true).
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);

  const text = new Intl.NumberFormat(locale, options).format(value);

  return (
    <span className="ticker" role="img" aria-label={text}>
      {Array.from(text).map((ch, i) =>
        /\d/.test(ch) ? (
          // 뒤에서부터 센 자리로 key 를 준다 — 앞자리가 늘어도 일의 자리 기둥은 그대로 이어진다.
          <Digit key={text.length - i} d={Number(ch)} animate={ready} />
        ) : (
          <span key={text.length - i} aria-hidden>
            {ch}
          </span>
        ),
      )}
    </span>
  );
}
