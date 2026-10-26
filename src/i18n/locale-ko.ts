// 이 로케일의 사전 한 덩어리 — locales.ts 가 동적 import 로만 부른다(로케일당 청크 하나).
// 네임스페이스 JSON 을 따로따로 지연 로드하면 46×3 개의 작은 청크가 생겨 폰(tailnet)에서 요청이 쏟아진다.
import { buildDict } from "./buildDict";

export default buildDict(import.meta.glob("./ko/*.json", { eager: true }));
