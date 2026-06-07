/**
 * 連鎖ボーナス（燃える炉）
 * ─────────────────────────────────────────────────────────
 * ソロゲームで連勝するほど配当に倍率が乗る。負けでリセット。
 * current_win_streak は recordWin/recordLoss でソロ専用に管理されているので、
 * これを直接読んで「次に勝つと何連勝目になるか」から倍率を引く。
 *
 * 使い方（ソロゲーム側）:
 *   if (won) {
 *     const c = awardChain(userId, basePayout, "slots", guildId);
 *     if (c.bonus > 0) descLines.push(c.line);
 *   }
 *   // ↑ awardChain の中で adjustBalance してるので、呼び出し側は何もしなくていい
 */
import { adjustBalance, getProfile } from "./bank";

type Tier = { min: number; mult: number; label: string };

export const CHAIN_TIERS: Tier[] = [
  { min: 1,  mult: 1.00, label: "" },
  { min: 2,  mult: 1.05, label: "🔥" },
  { min: 3,  mult: 1.10, label: "🔥" },
  { min: 5,  mult: 1.20, label: "🔥🔥" },
  { min: 7,  mult: 1.35, label: "🔥🔥" },
  { min: 10, mult: 1.50, label: "🔥🔥🔥" },
  { min: 15, mult: 1.75, label: "✦🔥🔥🔥" },
  { min: 20, mult: 2.00, label: "✦✦🔥🔥🔥" },
];

export function getChainMultiplier(streak: number): number {
  let m = 1.0;
  for (const tier of CHAIN_TIERS) if (streak >= tier.min) m = tier.mult;
  return m;
}

export function getChainLabel(streak: number): string {
  let l = "";
  for (const tier of CHAIN_TIERS) if (streak >= tier.min) l = tier.label;
  return l;
}

/**
 * ソロ勝利時に連鎖ボーナスを別取引として付与する。
 * recordWin より「前」に呼ぶこと（current_win_streak がまだ更新されてない状態を読む）。
 * @param basePayout 元の配当（純利益でなく払戻総額でOK・倍率はこの値に乗る）
 */
export function awardChain(userId: string, basePayout: number, game: string, guildId?: string): {
  bonus: number;
  mult: number;
  nextStreak: number;
  line: string;
} {
  const profile = getProfile(userId, guildId);
  const nextStreak = (profile.current_win_streak ?? 0) + 1;
  const mult = getChainMultiplier(nextStreak);
  const bonus = Math.floor(basePayout * (mult - 1));
  if (bonus > 0) {
    adjustBalance(userId, bonus, `連鎖ボーナス x${mult.toFixed(2)} (${nextStreak}連勝)`, game, guildId);
  }
  const label = getChainLabel(nextStreak);
  const line = bonus > 0
    ? `${label} 連鎖 **${nextStreak}連勝** ×${mult.toFixed(2)} → **+◈${bonus.toLocaleString()}**`
    : "";
  return { bonus, mult, nextStreak, line };
}
