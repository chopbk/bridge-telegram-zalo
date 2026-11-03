/**
 * Tool lấy Telegram chat / user id để điền .env
 *
 * Cách dùng:
 *   npm run telegram:ids              # lắng nghe tin → in id group/channel/user
 *   npm run telegram:chat -- -100123  # tra cứu 1 chat theo id hoặc @username
 *
 * Lưu ý: cùng 1 bot token không poll song song — tắt `npm run dev` / pm2 trước khi chạy.
 */
import { Bot, type Context } from 'grammy';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

function requireToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.error('Thiếu TELEGRAM_BOT_TOKEN trong .env');
    process.exit(1);
  }
  return token;
}

function formatChatLine(chat: {
  id: number;
  type: string;
  title?: string;
  username?: string;
  is_forum?: boolean;
}): string {
  const bits = [
    `id=${chat.id}`,
    `type=${chat.type}`,
    chat.title ? `title=${chat.title}` : null,
    chat.username ? `@${chat.username}` : null,
    chat.is_forum ? 'forum=yes' : null,
  ].filter(Boolean);
  return bits.join(' | ');
}

function hintForEnv(chat: { id: number; type: string; is_forum?: boolean }): string {
  if (chat.type === 'channel') {
    return `→ TELEGRAM_CHANNEL_ID=${chat.id}`;
  }
  if (chat.type === 'supergroup' || chat.type === 'group') {
    if (chat.is_forum) return `→ TELEGRAM_FORUM_GROUP_ID=${chat.id}`;
    return `→ Group id=${chat.id} (bật Topics nếu dùng làm forum inbox)`;
  }
  if (chat.type === 'private') {
    return `→ TELEGRAM_ADMIN_IDS+=${chat.id} (user id của bạn)`;
  }
  return '';
}

async function replyId(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat) return;

  const lines = [
    'Telegram ID',
    formatChatLine(chat),
    hintForEnv(chat),
  ];
  if (from) {
    lines.push(
      '',
      `from_user id=${from.id}` +
        (from.username ? ` @${from.username}` : '') +
        (from.first_name ? ` (${from.first_name})` : ''),
      `→ TELEGRAM_ADMIN_IDS=${from.id}`,
    );
  }
  if (ctx.message?.message_thread_id) {
    lines.push(`topic/thread id=${ctx.message.message_thread_id}`);
  }

  const text = lines.filter((l) => l != null && l !== '').join('\n');
  console.log('---');
  console.log(text);
  console.log('---');

  try {
    await ctx.reply(text);
  } catch (err) {
    console.error('Không reply được (bot có quyền gửi tin?):', err);
  }
}

async function resolveChat(bot: Bot, ref: string): Promise<void> {
  const chat = await bot.api.getChat(ref);
  const line = formatChatLine({
    id: chat.id,
    type: chat.type,
    title: 'title' in chat ? chat.title : undefined,
    username: 'username' in chat ? chat.username : undefined,
    is_forum: 'is_forum' in chat ? Boolean(chat.is_forum) : undefined,
  });
  console.log(line);
  console.log(hintForEnv({
    id: chat.id,
    type: chat.type,
    is_forum: 'is_forum' in chat ? Boolean(chat.is_forum) : undefined,
  }));
}

async function discoverMode(bot: Bot): Promise<void> {
  const me = await bot.api.getMe();
  console.log(`Bot @${me.username ?? me.id} — chế độ khám phá ID`);
  console.log('Tắt bridge (dev/pm2) nếu đang chạy cùng token.');
  console.log('');
  console.log('Cách lấy ID:');
  console.log('  1) Chat riêng với bot: gửi /start hoặc /id  → user id (ADMIN_IDS)');
  console.log('  2) Thêm bot vào group/supergroup (admin), gửi /id trong group → FORUM_GROUP_ID');
  console.log('  3) Thêm bot vào channel (admin), forward 1 post vào bot hoặc post /id');
  console.log('  4) Tra cứu: npm run telegram:chat -- -100…   hoặc  npm run telegram:chat -- @channel');
  console.log('');
  console.log('Đang lắng nghe… Ctrl+C để thoát.\n');

  bot.command(['start', 'id', 'chatid', 'where'], async (ctx) => {
    await replyId(ctx);
  });

  bot.on(['message', 'channel_post', 'my_chat_member'], async (ctx) => {
    // /start /id đã xử lý ở trên
    if (ctx.message?.text?.startsWith('/')) return;
    await replyId(ctx);
  });

  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  await bot.start({
    onStart: () => console.log('Polling OK — hãy nhắn /id trong group hoặc chat riêng.'),
  });
}

async function main(): Promise<void> {
  const token = requireToken();
  const bot = new Bot(token);
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));

  if (arg) {
    try {
      await resolveChat(bot, arg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Không lấy được chat "${arg}": ${msg}`);
      process.exit(1);
    }
    return;
  }

  await discoverMode(bot);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
