/* ============================================================
 * game.js —— 炒股达人 游戏主逻辑
 * 流程：输入姓名 → 选股（SNK-格力士 / 大米科技）→ 模拟炒股 → 结算
 *
 * 大米科技（硬核模式）：隐藏剧本 + 事件卡（新闻栏滚动）+ 涨跌停
 * ============================================================ */
'use strict';

const INIT_CASH = 10000;         // 初始资金
const TRADE_FEE_RATE = 0.0005;   // 手续费：交易额的 0.05%

/* ---------------- 股票配置（不展示玩法介绍，避免玩家提前知道套路） ---------------- */
const STOCKS = {
  snk: {
    key: 'snk',
    name: 'SNK-格力士',
    tag: 'SNK',
    price: 100,
    duration: 60,
    engine: 'classic',
    emoji: '🎯',
  },
  damai: {
    key: 'damai',
    name: 'DMI-大米科技',
    tag: 'DMI',
    price: 50,
    duration: 60,
    engine: 'damai',
    emoji: '🐉',
  },
};

/* ---------------- 氛围新闻池（非事件的背景滚动） ---------------- */
/* 已移除：事件新闻改为“触发一次显示一次”，不做背景滚动，避免信息过载 */

const $ = (id) => document.getElementById(id);

/* ---------------- 音效（WebAudio 合成，无需音频文件） ---------------- */
const FX = {
  ctx: null,
  _ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, type = 'sine', vol = 0.15, delay = 0) {
    try {
      this._ensure();
      const t = this.ctx.currentTime + delay;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g);
      g.connect(this.ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    } catch (e) { /* 忽略音频错误 */ }
  },
  buy()  { this.tone(680, 0.1, 'triangle', 0.18); this.tone(920, 0.08, 'triangle', 0.12, 0.05); },
  sell() { this.tone(420, 0.1, 'triangle', 0.18); this.tone(300, 0.1, 'triangle', 0.14, 0.05); },
  event() { this.tone(880, 0.09, 'square', 0.1); this.tone(1108, 0.12, 'square', 0.08, 0.08); },
  limit() { this.tone(220, 0.25, 'sawtooth', 0.12); this.tone(180, 0.3, 'sawtooth', 0.1, 0.1); },
  win()  { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.16, i * 0.13)); },
  lose() { [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.28, 'sawtooth', 0.08, i * 0.16)); },
};

/* ---------------- 称号表（从高到低匹配） ---------------- */
const TITLES = [
  { min: 1,        title: '股神·巴菲特转世', emoji: '👑', comment: '庄家被你打哭了，哭着求你别再来了。' },
  { min: 0.5,      title: '钻石级操盘手',     emoji: '💎', comment: '手速与胆识并存，庄家今天白干一场。' },
  { min: 0.2,      title: '炒股达人',         emoji: '🚀', comment: '有点东西，庄家少赚了一顿火锅。' },
  { min: 0.0001,   title: '幸运小散户',       emoji: '🍀', comment: '赚是赚了，就是有点少，再接再厉。' },
  { min: -0.0001,  title: '白忙活大师',       emoji: '😶', comment: '一顿操作猛如虎，一看收益二百五。' },
  { min: -0.2,     title: '炒股飞人',         emoji: '🛫', comment: '亏得飞起，庄家含泪收下你的学费。' },
  { min: -0.5,     title: '韭菜本韭',         emoji: '🌱', comment: '庄家：感谢老板送的韭菜！' },
  { min: -Infinity,title: '天台VIP会员',      emoji: '🏙️', comment: '天台风大，记得多穿件衣服。' },
];

function getTitle(rate) {
  return TITLES.find(t => rate >= t.min) || TITLES[TITLES.length - 1];
}

/* ---------------- 小工具 ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtMoney(n) {
  return (n >= 0 ? '' : '-') + '¥' + Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
}

function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }

/* ============================================================
 * NewsBar —— 新闻栏（事件卡的展示载体）
 * 不做滚动刷屏：平时安静，关键事件触发时显示一次，几秒后淡出。
 * ============================================================ */
const NewsBar = {
  timer: null,

  init() {
    this.idle();
  },

  _set(text, cls) {
    const track = $('news-track');
    track.innerHTML = `<span class="news-item ${cls}">${escapeHtml(text)}</span>`;
  },

  idle() {
    this._set('等待市场快讯…', 'dim');
  },

  // 事件触发：显示一次，5 秒后恢复安静
  pushEvent(rec) {
    const cls = {
      good: 'hot-up', limitup: 'hot-up', trap: 'hot-up',
      bad: 'hot-down', limitdown: 'hot-down',
      ambiguous: 'hot-gold',
    }[rec.type] || 'hot-gold';
    this._set(`${rec.emoji} ${rec.text}`, cls);

    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.idle(), 5000);
  },
};

/* ---------------- Toast（轻量提示，不弹窗） ---------------- */
let toastTimer = null;
function toast(msg, type = 'info') {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2000);
}

/* ---------------- 游戏主体 ---------------- */
const Game = {
  status: 'idle',   // idle | playing | ended
  name: '玩家',
  stockKey: 'snk',
  stock: STOCKS.snk,
  cash: INIT_CASH,
  shares: 0,
  cost: 0,
  timeLeft: STOCKS.snk.duration,
  timerId: null,
  market: null,
  chart: null,
  lastResult: null,
  lastLimitDir: null, // 涨跌停状态去重提示用

  init() {
    this.chart = new KLineChart($('chart'));
    this.market = new MarketEngine(STOCKS.snk.price);
    this.chart.curPrice = STOCKS.snk.price;
    this.chart.costPrice = null;
    this.chart.setData(this.market.bars);
    NewsBar.init();
    this.bindEvents();
    this.renderStockCards();
    this.render();
    showModal('name-modal');
    $('name-input').focus();
  },

  /* ---------- 选股卡片渲染（只给名字/价格/时长，不给玩法介绍） ---------- */
  renderStockCards() {
    const wrap = $('stock-cards');
    wrap.innerHTML = Object.values(STOCKS).map(st => `
      <div class="stock-card" data-key="${st.key}">
        <div class="card-head">
          <span class="card-emoji">${st.emoji}</span>
          <span class="card-name">${st.name}</span>
          <span class="card-tag">${st.tag}</span>
        </div>
        <div class="card-meta">
          <span>¥${st.price.toFixed(0)} 起</span>
          <span>${st.duration}s</span>
        </div>
        <div class="card-btn">点击选择 →</div>
      </div>`).join('');
    wrap.querySelectorAll('.stock-card').forEach(card => {
      card.addEventListener('click', () => this.startGame(card.dataset.key));
    });
  },

  bindEvents() {
    $('btn-buy10').addEventListener('click', () => this.buy(10, false));
    $('btn-sell10').addEventListener('click', () => this.sell(10, false));
    $('btn-allin').addEventListener('click', () => this.allIn());
    $('btn-clear').addEventListener('click', () => this.clearAll());
    $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.startGame(this.stockKey); });
    $('btn-upload').addEventListener('click', () => this.uploadScore());
    $('btn-again').addEventListener('click', () => this.again());
    $('btn-rank-from-start').addEventListener('click', () => this.showRank());
    $('btn-rank-from-result').addEventListener('click', () => this.showRank());
    $('btn-rank-close').addEventListener('click', () => hideModal('rank-modal'));
    $('btn-share-rank').addEventListener('click', () => this.shareResult());
    $('btn-share-save').addEventListener('click', () => this.saveShare());
    $('btn-share-close').addEventListener('click', () => hideModal('share-modal'));
  },

  totalAssets() {
    return this.cash + this.shares * (this.market ? this.market.price : this.stock.price);
  },

  /* ---------- 涨跌停状态（大米科技事件卡触发） ---------- */
  isLimitUp()   { return !!(this.market && this.market.limit && this.market.limit.dir === 'up'); },
  isLimitDown() { return !!(this.market && this.market.limit && this.market.limit.dir === 'down'); },


  /* ---------- 交易（含 0.05% 手续费，直接扣现金） ---------- */
  buy(shares, allIn) {
    if (this.status !== 'playing') return;
    if (this.isLimitUp()) {
      toast('🚫 涨停封板，买不进！', 'limit');
      FX.limit();
      return;
    }
    const price = this.market.price;
    const cost = price * shares;               // 成交额
    const spend = cost * (1 + TRADE_FEE_RATE); // 实际花费 = 成交额 + 手续费
    if (shares <= 0 || spend > this.cash + 1e-9) return;

    this.cash -= spend;
    // 成本均价按实际花费（含手续费）计算
    this.cost = this.shares > 0
      ? (this.cost * this.shares + spend) / (this.shares + shares)
      : price * (1 + TRADE_FEE_RATE);
    this.shares += shares;

    this.market.onBuy(shares, allIn, this.cash, price);
    FX.buy();
    this.render();
    this.chart.addMark(this.market.bars.length - 1, 'B');
  },

  sell(shares, allOut) {
    if (this.status !== 'playing') return;
    if (this.isLimitDown()) {
      toast('🚫 跌停封板，卖不出！', 'limit');
      FX.limit();
      return;
    }
    if (shares <= 0 || this.shares < shares) return;
    const price = this.market.price;

    const proceeds = price * shares * (1 - TRADE_FEE_RATE); // 到账 = 成交额 - 手续费
    this.cash += proceeds;
    this.shares -= shares;
    if (this.shares === 0) this.cost = 0;

    this.market.onSell(shares, allOut, this.shares + shares, price);
    FX.sell();
    this.render();
    this.chart.addMark(this.market.bars.length - 1, 'S');
  },

  allIn() {
    const price = this.market.price;
    // 全仓需预留手续费
    const shares = Math.floor(this.cash / (price * (1 + TRADE_FEE_RATE)));
    if (shares <= 0) return;
    this.buy(shares, true);
  },

  clearAll() {
    if (this.shares <= 0) return;
    this.sell(this.shares, true);
  },

  /* ---------- 游戏流程 ---------- */
  startGame(key) {
    const st = STOCKS[key] || STOCKS.snk;
    this.stockKey = st.key;
    this.stock = st;

    const input = $('name-input');
    this.name = input.value.trim().slice(0, 12) || '匿名玩家';
    hideModal('name-modal');

    this.status = 'playing';
    this.cash = INIT_CASH;
    this.shares = 0;
    this.cost = 0;
    this.timeLeft = st.duration;
    this.lastLimitDir = null;
    this.lastResult = null;

    // 构造对应引擎：大米科技用事件驱动妖股引擎
    this.market = st.engine === 'damai'
      ? new DamaiMarketEngine(st.price, st.duration)
      : new MarketEngine(st.price);
    this.market.onEvent = (rec) => this.onMarketEvent(rec);

    this.chart.curPrice = st.price;
    this.chart.costPrice = null;
    this.chart.marks = [];
    this.chart.events = [];
    this.chart.setData(this.market.bars);
    NewsBar.idle();

    clearInterval(this.timerId);
    this.timerId = setInterval(() => this.tick(), 1000);
    this.tick(); // 立即走第一根K线
  },

  /* ---------- 事件卡触发回调：新闻栏 + 图表标记 + 涨跌停提示 ---------- */
  onMarketEvent(rec) {
    NewsBar.pushEvent(rec);
    this.chart.addEventMark(rec);
    FX.event();
    if (rec.type === 'limitup') {
      toast('🔴 重大利好，涨停封板！', 'limit');
      this.lastLimitDir = 'up';
      FX.limit();
    } else if (rec.type === 'limitdown') {
      toast('🟢 重大利空，跌停封板！', 'limit');
      this.lastLimitDir = 'down';
      FX.limit();
    }
    this.render();
  },

  tick() {
    this.timeLeft--;
    this.market.tick();

    // 涨跌停开板提示
    const lim = this.market.limit;
    if (lim && lim.dir !== this.lastLimitDir) {
      this.lastLimitDir = lim.dir;
    } else if (!lim && this.lastLimitDir) {
      toast('开板了，可以正常交易', 'info');
      this.lastLimitDir = null;
    }

    this.render();
    this.chart.setData(this.market.bars);
    if (this.timeLeft <= 0) this.endGame();
  },

  endGame() {
    clearInterval(this.timerId);
    this.status = 'ended';

    const total = this.totalAssets();
    const profit = total - INIT_CASH;
    const rate = profit / INIT_CASH;
    const t = getTitle(rate);

    $('result-emoji').textContent = t.emoji;
    $('result-title').textContent = t.title;
    $('result-comment').textContent = t.comment;
    $('result-name').textContent = this.name;
    $('result-stock').textContent = this.stock.name;
    $('result-profit').textContent = fmtMoney(profit);
    $('result-profit').className = 'result-profit ' + (profit >= 0 ? 'up' : 'down');
    $('result-rate').textContent = (rate >= 0 ? '+' : '') + (rate * 100).toFixed(2) + '%';
    $('result-rate').className = 'result-rate ' + (profit >= 0 ? 'up' : 'down');
    $('result-shares').textContent = this.shares;
    $('result-price').textContent = this.market.price.toFixed(2);
    $('btn-upload').disabled = false;
    $('btn-upload').textContent = '上传成绩';

    this.lastResult = {
      name: this.name,
      stock: this.stock.name,
      profit: Math.round(profit * 100) / 100,
      rate: Math.round(rate * 10000) / 10000,
      title: t.title,
      emoji: t.emoji,
      time: Date.now(),
    };

    showModal('result-modal');
    profit >= 0 ? FX.win() : FX.lose();
    this.render();
  },

  /* ---------- 上传成绩（Upstash Redis） ---------- */
  async uploadScore() {
    const r = this.lastResult;
    if (!r) return;
    const btn = $('btn-upload');
    btn.disabled = true;
    btn.textContent = '上传中…';
    $('upload-msg').textContent = '';

    try {
      await uploadScoreToRedis(r);
      hideModal('result-modal');
      this.showRank();
    } catch (e) {
      $('upload-msg').textContent = '上传失败：' + (e.message || '网络错误') + '，请重试';
      btn.disabled = false;
      btn.textContent = '上传成绩';
    }
  },

  /* ---------- 排行榜（从 Redis 实时拉取） ---------- */
  async showRank() {
    showModal('rank-modal');
    const el = $('rank-list');
    el.innerHTML = '<div class="rank-empty">加载中…</div>';
    // 没有本局成绩时不可分享（从开始弹窗进入排行榜的场景）
    $('btn-share-rank').disabled = !this.lastResult;
    try {
      const list = await fetchRanking(20);
      if (!list.length) {
        el.innerHTML = '<div class="rank-empty">排行榜还是空的，快来抢第一名！</div>';
      } else {
        el.innerHTML = list.map((r, i) => `
          <div class="rank-row">
            <span class="rank-no ${i < 3 ? 'top' : ''}">${i + 1}</span>
            <span class="rank-name">${escapeHtml(r.name)}</span>
            <span class="rank-title"><span class="rank-stock">${escapeHtml(r.stock)}</span> ${escapeHtml(r.title)}</span>
            <span class="rank-profit ${r.profit >= 0 ? 'up' : 'down'}">${(r.rate * 100).toFixed(1)}%</span>
          </div>`).join('');
      }
    } catch (e) {
      el.innerHTML = '<div class="rank-empty">排行榜加载失败，请检查网络后重试</div>';
    }
  },

  /* ---------- 分享收益（生成截图卡片） ---------- */
  async shareResult() {
    const r = this.lastResult;
    if (!r) return;
    const dataUrl = await buildShareCard(r);
    this.shareDataUrl = dataUrl;
    $('share-img').src = dataUrl;
    showModal('share-modal');
  },

  saveShare() {
    if (!this.shareDataUrl) return;
    const a = document.createElement('a');
    a.href = this.shareDataUrl;
    a.download = '炒股达人-收益.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  /* ---------- 再来一局（回到选股） ---------- */
  again() {
    hideModal('result-modal');
    hideModal('rank-modal');
    clearInterval(this.timerId);

    this.status = 'idle';
    this.cash = INIT_CASH;
    this.shares = 0;
    this.cost = 0;
    this.timeLeft = STOCKS.snk.duration;
    this.lastResult = null;
    this.market = new MarketEngine(STOCKS.snk.price);
    this.chart.curPrice = STOCKS.snk.price;
    this.chart.costPrice = null;
    this.chart.marks = [];
    this.chart.events = [];
    this.chart.setData(this.market.bars);
    NewsBar.idle();

    $('name-input').value = this.name;
    this.render();
    showModal('name-modal');
    $('name-input').focus();
    $('name-input').select();
  },

  /* ---------- 界面渲染 ---------- */
  render() {
    const st = this.stock;
    const price = this.market ? this.market.price : st.price;
    const up = price >= st.price;

    // 顶栏股票名 / 标题
    $('top-stock-name').innerHTML = `${st.name} <span class="tag" id="top-stock-tag">${st.tag}</span>`;
    $('chart-title').textContent = `${st.name} · 模拟盘`;

    // 同步现价 / 成本价到图表（现价虚线、成本虚线）
    this.chart.curPrice = price;
    this.chart.costPrice = this.shares > 0 ? this.cost : null;

    $('top-price').textContent = price.toFixed(2);
    $('top-price').className = 'stock-price ' + (up ? 'up' : 'down');
    const chg = (price - st.price) / st.price * 100;
    $('top-change').textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
    $('top-change').className = 'stock-change ' + (up ? 'up' : 'down');

    const total = this.totalAssets();
    const profit = total - INIT_CASH;
    const rate = profit / INIT_CASH;

    $('profit-amount').textContent = fmtMoney(profit);
    $('profit-amount').className = 'profit-amount ' + (profit >= 0 ? 'up' : 'down');
    $('profit-rate').textContent = (rate >= 0 ? '+' : '') + (rate * 100).toFixed(2) + '%';
    $('profit-rate').className = 'profit-rate ' + (profit >= 0 ? 'up' : 'down');

    $('total-assets').textContent = fmtMoney(total);
    $('cash').textContent = fmtMoney(this.cash);
    $('holdings').textContent = this.shares + ' 股';
    $('cost').textContent = this.shares > 0 ? this.cost.toFixed(2) : '--';
    $('cur-price').textContent = price.toFixed(2);
    $('market-value').textContent = fmtMoney(this.shares * price);

    // 按钮可用性（预留手续费 + 涨跌停封板限制）
    const playing = this.status === 'playing';
    const limitUp = this.isLimitUp();
    const limitDown = this.isLimitDown();
    $('btn-buy10').disabled = !playing || limitUp || this.cash < price * 10 * (1 + TRADE_FEE_RATE);
    $('btn-sell10').disabled = !playing || limitDown || this.shares < 10;
    $('btn-allin').disabled = !playing || limitUp || this.cash < price * (1 + TRADE_FEE_RATE);
    $('btn-clear').disabled = !playing || limitDown || this.shares === 0;

    // 倒计时 + 进度条
    const left = Math.max(0, this.timeLeft);
    const m = Math.floor(left / 60), s = left % 60;
    const tEl = $('timer');
    tEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    tEl.className = 'timer' + (this.status === 'playing' && left <= 10 ? ' danger' : '');
    $('time-bar').style.width = (left / st.duration * 100) + '%';

    // 状态提示
    if (this.status === 'idle') $('chart-status').textContent = '等待开始…';
    else if (this.status === 'ended') $('chart-status').textContent = '游戏结束';
    else if (limitUp) $('chart-status').textContent = '涨停封板 🔴';
    else if (limitDown) $('chart-status').textContent = '跌停封板 🟢';
    else $('chart-status').textContent = '进行中';
  },
};

/* ============================================================
 * buildShareCard —— 生成收益分享截图（竖版 PNG 卡片）
 * 内容：游戏名 / 玩家名 / 股票 / 称号 / 收益 / 底部游戏地址二维码
 * ============================================================ */
const SHARE_URL = 'https://game.ikeno.top/';
const SHARE_FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function buildShareCard(rec) {
  const W = 640, H = 960;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';

  // 背景渐变
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1b2438');
  bg.addColorStop(0.6, '#131a2b');
  bg.addColorStop(1, '#0d1117');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 装饰圆环
  ctx.strokeStyle = 'rgba(240,185,11,0.08)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(560, 140, 90, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-40, 800, 130, 0, Math.PI * 2);
  ctx.stroke();

  // 标题
  ctx.fillStyle = '#f0b90b';
  ctx.font = 'bold 44px ' + SHARE_FONT;
  ctx.fillText('📈 炒股达人', W / 2, 110);
  ctx.fillStyle = '#8b94a8';
  ctx.font = '18px ' + SHARE_FONT;
  ctx.fillText((rec.stock || 'SNK-格力士') + ' · 模拟炒股', W / 2, 150);

  // 分隔线
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  ctx.moveTo(90, 190);
  ctx.lineTo(W - 90, 190);
  ctx.stroke();

  // 玩家名 + 称号
  ctx.fillStyle = '#e6ecf5';
  ctx.font = 'bold 30px ' + SHARE_FONT;
  ctx.fillText(rec.name || '匿名玩家', W / 2, 262);
  ctx.fillStyle = rec.profit >= 0 ? '#ff8a8c' : '#6ee7b7';
  ctx.font = 'bold 50px ' + SHARE_FONT;
  ctx.fillText((rec.emoji || '') + ' ' + rec.title, W / 2, 338);

  // 收益框
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(80, 386, W - 160, 196, 18);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#8b94a8';
  ctx.font = '20px ' + SHARE_FONT;
  ctx.fillText('本局收益', W / 2, 446);
  const up = rec.profit >= 0;
  ctx.fillStyle = up ? '#ff4d4f' : '#2ebd85';
  ctx.font = 'bold 62px ' + SHARE_FONT;
  ctx.fillText((up ? '+' : '-') + fmtMoney(Math.abs(rec.profit)), W / 2, 518);
  ctx.font = 'bold 26px ' + SHARE_FONT;
  ctx.fillText((up ? '+' : '') + (rec.rate * 100).toFixed(2) + '%', W / 2, 560);

  // 底部二维码卡片
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  ctx.roundRect(160, 626, W - 320, 252, 18);
  ctx.fill();
  ctx.stroke();

  // 二维码（qrcode-generator 全局 qrcode）
  const qr = qrcode(0, 'M');
  qr.addData(SHARE_URL);
  qr.make();
  const qrImg = await loadImage(qr.createDataURL(6, 2));
  ctx.drawImage(qrImg, W / 2 - 90, 644, 180, 180);

  ctx.fillStyle = '#e6ecf5';
  ctx.font = 'bold 22px ' + SHARE_FONT;
  ctx.fillText('扫码立即来玩', W / 2, 850);
  ctx.fillStyle = '#f0b90b';
  ctx.font = '16px ' + SHARE_FONT;
  ctx.fillText(SHARE_URL, W / 2, 880);

  return canvas.toDataURL('image/png');
}

document.addEventListener('DOMContentLoaded', () => Game.init());
