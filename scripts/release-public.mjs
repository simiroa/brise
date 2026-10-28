#!/usr/bin/env node
// 공개 레포 릴리스 — 서명 빌드 → latest.json 조립 → 공개 레포에 **정식(Latest)** 릴리스 → 업데이트 주소 확인.
//
//   node scripts/release-public.mjs [--build] --notes <릴리스노트.md> [--publish] [--target <공개 레포 커밋/브랜치>]
//
// 기본은 미리보기(dry-run): 만들 latest.json 과 실행할 gh 명령만 보여 주고 아무것도 올리지 않는다.
// `--publish` 를 줘야 실제로 릴리스를 만들고, 끝에 앱이 보는 업데이트 주소가 새 버전을 돌려주는지 확인한다.
//
// 왜 스크립트인가(docs/RELEASING.md §0): v0.5.3 까지 공개 레포 릴리스가 Pre-release 로만, latest.json·.sig 없이
// 올라가 업데이트 주소가 404 였고, 앱은 그 실패를 조용히 삼켜(updater.ts 는 진단에만 남긴다) 아무도 몰랐다.
// 손으로 하는 서명·조립·업로드 중 하나만 빠져도 같은 일이 나므로 한 번에 묶고 마지막에 주소를 직접 친다.
//
// 공개 레포·주소는 tauri.conf.json 의 plugins.updater.endpoints[0] 에서 읽는다 — 주소를 바꾸면 이 스크립트도 따라온다.
// 공개 레포 스냅샷(소스)은 이 스크립트 전에 scripts/export-public.mjs 로 내보내 푸시해 둔다(그 커밋에 태그가 붙는다).
// ponytail: Windows x86_64 하나만 조립한다. macOS/Linux 를 열면 플랫폼별 빌드를 모아야 해 tauri-action(CI)로 옮긴다.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

/** 업데이트 주소에서 GitHub 레포를 뽑는다 — `https://github.com/<owner>/<repo>/releases/...` 꼴만 받는다. */
export function repoFromEndpoint(endpoint) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\//.exec(endpoint ?? "");
  return m ? `${m[1]}/${m[2]}` : null;
}

/** 세 곳(package.json · tauri.conf.json · Cargo.toml)의 버전이 같아야 한다. 다르면 무엇이 다른지 돌려준다. */
export function versionMismatch({ pkg, conf, cargo }) {
  return pkg === conf && conf === cargo ? null : `package.json ${pkg} · tauri.conf.json ${conf} · Cargo.toml ${cargo}`;
}

/** Tauri v2 업데이터 매니페스트(latest.json). createUpdaterArtifacts:true 라 업데이트 대상은 NSIS 설치 파일 자체다. */
export function buildManifest({ version, notes, pubDate, signature, url }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: { "windows-x86_64": { signature: signature.trim(), url } },
  };
}

function readVersions() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const confJson = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  const cargoToml = fs.readFileSync(path.join(ROOT, "src-tauri/Cargo.toml"), "utf8");
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
  return { pkg, conf: confJson.version, cargo, confJson };
}

function fail(msg) {
  console.error(`release-public: ${msg}`);
  process.exit(1);
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} 실패(exit ${r.status})`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const publish = args.includes("--publish");
  const notesFile = opt("--notes");
  const target = opt("--target");

  const v = readVersions();
  const mismatch = versionMismatch(v);
  if (mismatch) fail(`버전이 서로 다르다 — ${mismatch}`);
  const version = v.pkg;
  const tag = `v${version}`;
  const endpoint = v.confJson.plugins?.updater?.endpoints?.[0];
  const repo = repoFromEndpoint(endpoint);
  if (!repo) fail(`업데이트 주소에서 GitHub 레포를 못 읽었다: ${endpoint}`);
  if (!notesFile || !fs.existsSync(notesFile)) fail("--notes <릴리스노트 파일> 이 필요하다(사용자에게 보이는 변경 요약)");
  const notes = fs.readFileSync(notesFile, "utf8").trim();

  if (args.includes("--build")) {
    const keyPath = path.join(os.homedir(), ".tauri", "brise_updater.key");
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !fs.existsSync(keyPath)) fail(`서명 키가 없다: ${keyPath}`);
    const env = process.env.TAURI_SIGNING_PRIVATE_KEY
      ? {}
      : { TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyPath, "utf8"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" };
    run("npm", ["run", "build"], env);
    run("npx", ["tauri", "build"], env);
  }

  const product = v.confJson.productName;
  // 빌드 산출 폴더는 머신마다 다르다(전역 cargo 설정의 target-dir 이 D: 일 수 있다) — cargo 에게 묻는다.
  const targetDir = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: path.join(ROOT, "src-tauri"), encoding: "utf8", maxBuffer: 1 << 28 })).target_directory;
  const bundle = path.join(targetDir, "release/bundle");
  const exe = path.join(bundle, "nsis", `${product}_${version}_x64-setup.exe`);
  const sig = `${exe}.sig`;
  const msi = path.join(bundle, "msi", `${product}_${version}_x64_en-US.msi`);
  for (const f of [exe, sig]) if (!fs.existsSync(f)) fail(`산출물이 없다: ${f} — --build 로 서명 빌드부터`);

  const url = `https://github.com/${repo}/releases/download/${tag}/${path.basename(exe)}`;
  const manifest = buildManifest({
    version,
    notes,
    pubDate: new Date().toISOString(),
    signature: fs.readFileSync(sig, "utf8"),
    url,
  });
  const manifestPath = path.join(bundle, "latest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`latest.json → ${manifestPath}\n${JSON.stringify({ ...manifest, platforms: { "windows-x86_64": { url } } }, null, 2)}`);

  const assets = [exe, sig, manifestPath, ...(fs.existsSync(msi) ? [msi] : [])];
  // 정식 릴리스(--latest)로 — Pre-release 는 업데이트 주소(releases/latest)에 잡히지 않는다.
  const ghArgs = ["release", "create", tag, "-R", repo, "--title", `Brise ${tag}`, "--notes-file", notesFile, "--latest",
    ...(target ? ["--target", target] : []), ...assets];
  if (!publish) {
    console.log(`\n[미리보기] 실행할 명령:\ngh ${ghArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}\n올리려면 --publish`);
    return;
  }

  const exists = spawnSync("gh", ["release", "view", tag, "-R", repo], { stdio: "ignore", shell: process.platform === "win32" });
  if (exists.status === 0) fail(`${repo} 에 ${tag} 릴리스가 이미 있다 — 버전을 올리거나 기존 릴리스를 직접 정리`);
  execFileSync("gh", ghArgs, { cwd: ROOT, stdio: "inherit" });

  // 앱이 실제로 치는 주소를 그대로 친다 — 200 + 새 버전이 아니면 실패로 끝낸다.
  const res = await fetch(endpoint, { redirect: "follow" });
  const body = res.ok ? await res.json().catch(() => null) : null;
  const got = body?.version?.replace(/^v/, "");
  if (got !== version) fail(`업데이트 주소 확인 실패: ${endpoint} → HTTP ${res.status}, version ${body?.version ?? "없음"} (기대 ${version})`);
  console.log(`\n완료: ${repo} ${tag} 정식 릴리스, 업데이트 주소가 ${version} 을 돌려준다.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}
