/**
 * 설정 행의 N칸 선택 띠 — 호출부 18곳의 API(value/onChange/options/ariaLabel)를 그대로 두고, 그림과 키보드는
 * 공용 `SegmentedControl`(표시가 미끄러지고 활성 칸만 탭 정지점, 방향키·Home·End)에 맡긴다.
 * 폭은 설정 컨트롤 고정 폭(SETTINGS_CTRL_WIDTH)에 균등 분할로 채운다 — 글자 길이가 칸 너비를 정하면 같은
 * 스트립 안에서도 칸이 들쭉날쭉해지기 때문이다.
 * 처음에는 AppearanceSection 의 2칸 토글이었다가 AiCapabilityCatalog 가 두 번째 사용처가 되며 뽑혔다.
 */
import { SegmentedControl } from "../common/SegmentedControl";
import { SETTINGS_CTRL_WIDTH } from "./shared";

export function SegGroup<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  /** disabled: 이 기기에서 고를 수 없는 칸(예: Windows 10 의 아크릴) — 보이되 선택되지 않는다.
   *  title 에 이유를 적는다. */
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  ariaLabel: string;
}) {
  return (
    <div style={{ width: SETTINGS_CTRL_WIDTH, minWidth: SETTINGS_CTRL_WIDTH }}>
      <SegmentedControl fill value={value} onChange={onChange} options={options} ariaLabel={ariaLabel} />
    </div>
  );
}
