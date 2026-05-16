/**
 * Discord interaction の reply / editReply / followUp を例外で握り潰すラッパ。
 *
 * 用途：
 * - Discord 側のネットワーク失敗 / 権限変更 / メッセージ削除でゲーム関数が中断し、
 *   ロック解放や DB 正合性が損なわれるのを防ぐ。
 * - 通信失敗はゲーム結果（残高・記録）の正しさには影響しない設計に統一する。
 *
 * 失敗時は console.warn でログを残すだけで、呼び出し側には例外を再送しない。
 */
import type {
  BaseInteraction,
  InteractionReplyOptions,
  InteractionEditReplyOptions,
  Message,
  MessageEditOptions,
  MessagePayload,
  RepliableInteraction,
} from "discord.js";

type Repliable = BaseInteraction & {
  reply: (options: InteractionReplyOptions | string) => Promise<unknown>;
  editReply: (options: InteractionEditReplyOptions | MessagePayload | string) => Promise<unknown>;
  followUp: (options: InteractionReplyOptions | string) => Promise<unknown>;
  replied?: boolean;
  deferred?: boolean;
};

export async function safeReply(
  interaction: RepliableInteraction,
  options: InteractionReplyOptions | string,
): Promise<void> {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(options as InteractionReplyOptions);
    } else {
      await interaction.reply(options as InteractionReplyOptions);
    }
  } catch (err) {
    console.warn("[safeReply] reply failed:", err);
  }
}

export async function safeEditReply(
  interaction: RepliableInteraction,
  options: InteractionEditReplyOptions | string,
): Promise<void> {
  try {
    await interaction.editReply(options as InteractionEditReplyOptions);
  } catch (err) {
    console.warn("[safeReply] editReply failed:", err);
  }
}

export async function safeFollowUp(
  interaction: RepliableInteraction,
  options: InteractionReplyOptions | string,
): Promise<void> {
  try {
    await interaction.followUp(options as InteractionReplyOptions);
  } catch (err) {
    console.warn("[safeReply] followUp failed:", err);
  }
}

export async function safeMessageEdit(
  message: Message,
  options: MessageEditOptions | string,
): Promise<void> {
  try {
    await message.edit(options as MessageEditOptions);
  } catch (err) {
    console.warn("[safeReply] message.edit failed:", err);
  }
}
