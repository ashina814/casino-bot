/**
 * 特別ユーザーへのトリビュート（敬意・ねぎらい）
 *
 * 開発過程で特別な貢献をしてくれたユーザー、あるいは
 * 物語的に意味を持つ存在に対して、専用の二つ名を授ける仕組み。
 *
 * このファイルに登録すると、対象ユーザーの ensureUser 時に自動付与される。
 */
import { db } from "./db";

export type SpecialTribute = {
  /** 対象 Discord ユーザーID（snowflake） */
  userId: string;
  /** 授ける二つ名のキー（titlesCatalog と一致させる） */
  titleKey: string;
  /** 授ける二つ名の表示名 */
  titleName: string;
  /** /アステル status などで本人だけに表示される特別メッセージ（メタフィクション） */
  metaMessage: string;
};

/**
 * 特別ユーザー登録簿。
 * 物語的な「二代目」── 座敷童が留守の間、彼女が座敷童のロールプレイをして
 * 場を守ってくれた。座敷童は戻ってきた今、彼女に正式に「二代目」の名を授ける。
 */
export const SPECIAL_TRIBUTES: SpecialTribute[] = [
  {
    userId: "1475786968804757555",
    titleKey: "second_zashiki",
    titleName: "二代目",
    metaMessage:
      "*「ねえ、きみには特別にお礼を言わなきゃ。\n" +
      "　わたしが眠ってた間、きみがわたしの代わりにこの場所を守ってくれたでしょ？\n" +
      "　誰も気づかないような小さな心づかいも、わたしにはちゃんと見えてたよ。\n" +
      "　だからきみに、『二代目』の名前を贈ろうと思うんだ。\n" +
      "　……これからも、よろしくね。」*",
  },
];

export function getSpecialTribute(userId: string): SpecialTribute | undefined {
  return SPECIAL_TRIBUTES.find((t) => t.userId === userId);
}

/**
 * 該当ユーザーなら専用二つ名を付与（冪等）。
 * ensureUser からフックして呼ぶ。
 */
export function grantSpecialTributes(userId: string): void {
  const tribute = getSpecialTribute(userId);
  if (!tribute) return;
  try {
    db.prepare(
      "INSERT OR IGNORE INTO titles (user_id, title_key, title_name) VALUES (?, ?, ?)"
    ).run(userId, tribute.titleKey, tribute.titleName);
  } catch (e) {
    console.warn("[specialUsers] grant failed:", e);
  }
}
