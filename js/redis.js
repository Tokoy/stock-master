/* ============================================================
 * redis.js —— Upstash Redis REST 客户端（浏览器直连）
 *
 * 数据模型：Sorted Set「stock-master:ranking」
 *   score  = 收益金额（元，可为负）
 *   member = JSON 字符串 { name, stock, profit, rate, title, time }
 *
 * ⚠️ 注意：token 明文写在前端，任何访问者 F12 即可看到并读写
 *    该 Redis。仅适合个人/小范围使用；若要公开部署，
 *    建议改为后端代理（如 Cloudflare Worker）保管 token。
 * ============================================================ */
'use strict';

const UPSTASH_URL = 'https://native-tiger-213450.upstash.io';
const UPSTASH_TOKEN = 'gQAAAAAAA0HKAAIgcDJkYjU0YmM3ZmM4ZWE0MWJiOGQ5OGUwNWFjYzkyNzZiMQ';
const RANK_KEY = 'stock-master:ranking';

/** 执行任意 Redis 命令（REST 风格：/command/arg1/arg2/...） */
async function redisCmd(...parts) {
  const path = parts.map(p => encodeURIComponent(String(p))).join('/');
  const res = await fetch(`${UPSTASH_URL}/${path}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

/** 上传一局成绩，返回该记录在有序集合中的排名（1-based，负数表示插入成功） */
function uploadScoreToRedis(record) {
  return redisCmd('zadd', RANK_KEY, record.profit, JSON.stringify(record));
}

/** 拉取排行榜 top N（按收益降序） */
async function fetchRanking(limit = 20) {
  const raw = await redisCmd('zrevrange', RANK_KEY, 0, limit - 1, 'WITHSCORES');
  const list = [];
  for (let i = 0; i < raw.length; i += 2) {
    let rec;
    try {
      rec = JSON.parse(raw[i]);
    } catch (e) {
      rec = { name: raw[i], title: '未知玩家' };
    }
    rec.profit = parseFloat(raw[i + 1]);
    if (typeof rec.rate !== 'number') rec.rate = 0;
    if (!rec.stock) rec.stock = '';
    if (!rec.title) rec.title = '';
    list.push(rec);
  }
  return list;
}

/** 清空排行榜 */
function clearRanking() {
  return redisCmd('del', RANK_KEY);
}
