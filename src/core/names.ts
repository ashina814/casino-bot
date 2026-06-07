/**
 * ニックネーム解決ヘルパ。
 * サーバー固有のニックネーム > グローバル表示名 > ユーザー名 の順で返す。
 *
 * interaction.user.displayName はグローバルの "Display Name"（@表示名）であり、
 * サーバーごとに設定したニックネームは反映されない。
 * 本ヘルパは GuildMember.displayName（= nickname ?? user.displayName）を優先する。
 */
import type { GuildMember, ChatInputCommandInteraction, ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction, Guild, User } from "discord.js";

type AnyInteraction = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction;

/** interaction の発火者の、サーバー表示名（ニックネーム優先）を返す。 */
export function memberName(interaction: AnyInteraction): string {
  const m = interaction.member as GuildMember | null;
  return m?.displayName ?? interaction.user.displayName ?? interaction.user.username;
}

/** 任意ユーザーのサーバー表示名を guild から引く（キャッシュ優先・フォールバックは user の displayName）。 */
export async function memberNameOf(guild: Guild | null, user: User): Promise<string> {
  if (!guild) return user.displayName ?? user.username;
  try {
    const m = guild.members.cache.get(user.id) ?? await guild.members.fetch(user.id).catch(() => null);
    return m?.displayName ?? user.displayName ?? user.username;
  } catch {
    return user.displayName ?? user.username;
  }
}

/** 同期版: キャッシュにあれば返す、無ければ user の displayName にフォールバック。 */
export function memberNameOfCached(guild: Guild | null, user: User): string {
  const m = guild?.members.cache.get(user.id);
  return m?.displayName ?? user.displayName ?? user.username;
}
