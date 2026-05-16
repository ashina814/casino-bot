/**
 * 座敷童ビジュアル素材（GIF/PNG）の読み込みヘルパ。
 *
 * 設計：
 * - 素材は project root の `assets/zashiki/` に置く（dev: ts-node, prod: dist 共通で cwd 解決）
 * - 起動時に存在チェック → 不在なら無効化（warn のみ・呼び出し側はフォールバック）
 * - 同じファイル名のまま使い回せるよう `AttachmentBuilder` を毎回新規生成する
 */
import { existsSync } from "fs";
import { resolve } from "path";
import { AttachmentBuilder } from "discord.js";

const ASSET_ROOT = resolve(process.cwd(), "assets", "zashiki");

type SceneKey = "idle";

const SCENE_FILES: Record<SceneKey, string> = {
  idle: "idle.gif",
};

function fullPath(scene: SceneKey): string {
  return resolve(ASSET_ROOT, SCENE_FILES[scene]);
}

const available: Record<SceneKey, boolean> = {
  idle: existsSync(fullPath("idle")),
};

if (!available.idle) {
  console.warn(`[zashikiAsset] idle.gif not found at ${fullPath("idle")} — daily embed will skip thumbnail`);
}

export type ZashikiAttachment = {
  attachment: AttachmentBuilder;
  thumbnailUrl: string;
};

/**
 * scene 名から添付ファイルと thumbnail URL を返す。
 * ファイル不在時は null（呼び出し側で thumbnail なしにフォールバック）。
 */
export function getZashikiAttachment(scene: SceneKey): ZashikiAttachment | null {
  if (!available[scene]) return null;
  const filename = SCENE_FILES[scene];
  return {
    attachment: new AttachmentBuilder(fullPath(scene), { name: filename }),
    thumbnailUrl: `attachment://${filename}`,
  };
}
