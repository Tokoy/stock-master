/* ============================================================
 * game.js —— 炒股达人 游戏主逻辑
 * 流程：输入姓名 → 60 秒模拟炒股 → 结算弹窗（称号/上传/再来一局）
 * ============================================================ */
'use strict';

const GAME_DURATION = 60;        // 秒
const INIT_CASH = 10000;         // 初始资金
const INIT_PRICE = 100;          // 初始股价
const TRADE_FEE_RATE = 0.0005;   // 手续费：交易额的 0.05%
const RECORD_KEY = 'stock-master-records';

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

/* ---------------- 游戏主体 ---------------- */
const Game = {
  status: 'idle',   // idle | playing | ended
  name: '玩家',
  cash: INIT_CASH,
  shares: 0,
  cost: 0,
  timeLeft: GAME_DURATION,
  timerId: null,
  market: null,
  chart: null,
  lastResult: null,

  init() {
    this.chart = new KLineChart($('chart'));
    this.market = new MarketEngine(INIT_PRICE);
    this.chart.curPrice = INIT_PRICE;
    this.chart.costPrice = null;
    this.chart.setData(this.market.bars);
    this.bindEvents();
    this.render();
    showModal('name-modal');
    $('name-input').focus();
  },

  bindEvents() {
    $('btn-buy10').addEventListener('click', () => this.buy(10, false));
    $('btn-sell10').addEventListener('click', () => this.sell(10, false));
    $('btn-allin').addEventListener('click', () => this.allIn());
    $('btn-clear').addEventListener('click', () => this.clearAll());
    $('btn-start').addEventListener('click', () => this.startGame());
    $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.startGame(); });
    $('btn-upload').addEventListener('click', () => this.uploadScore());
    $('btn-again').addEventListener('click', () => this.again());
    $('btn-rank-close').addEventListener('click', () => hideModal('rank-modal'));
    $('btn-rank-clear').addEventListener('click', () => {
      localStorage.removeItem(RECORD_KEY);
      this.showRank();
    });
  },

  totalAssets() {
    return this.cash + this.shares * (this.market ? this.market.price : INIT_PRICE);
  },

  /* ---------- 交易（含 0.05% 手续费，直接扣现金） ---------- */
  buy(shares, allIn) {
    if (this.status !== 'playing') return;
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
  startGame() {
    const input = $('name-input');
    this.name = input.value.trim().slice(0, 12) || '匿名玩家';
    hideModal('name-modal');
    this.status = 'playing';
    clearInterval(this.timerId);
    this.timerId = setInterval(() => this.tick(), 1000);
    this.tick(); // 立即走第一根K线
  },

  tick() {
    this.timeLeft--;
    this.market.tick();
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

  /* ---------- 上传成绩（存本机 localStorage） ---------- */
  uploadScore() {
    const r = this.lastResult;
    if (!r) return;
    const btn = $('btn-upload');
    btn.disabled = true;
    btn.textContent = '上传中…';

    setTimeout(() => {
      const list = JSON.parse(localStorage.getItem(RECORD_KEY) || '[]');
      list.push(r);
      list.sort((a, b) => b.rate - a.rate);
      localStorage.setItem(RECORD_KEY, JSON.stringify(list.slice(0, 100)));
      hideModal('result-modal');
      this.showRank();
    }, 700);
  },

  showRank() {
    const list = JSON.parse(localStorage.getItem(RECORD_KEY) || '[]');
    const el = $('rank-list');
    if (!list.length) {
      el.innerHTML = '<div class="rank-empty">暂无成绩，快去玩一局吧！</div>';
    } else {
      el.innerHTML = list.slice(0, 20).map((r, i) => `
        <div class="rank-row">
          <span class="rank-no ${i < 3 ? 'top' : ''}">${i + 1}</span>
          <span class="rank-name">${escapeHtml(r.name)}</span>
          <span class="rank-title">${r.emoji || ''} ${escapeHtml(r.title)}</span>
          <span class="rank-profit ${r.profit >= 0 ? 'up' : 'down'}">${(r.rate * 100).toFixed(1)}%</span>
        </div>`).join('');
    }
    showModal('rank-modal');
  },

  /* ---------- 再来一局 ---------- */
  again() {
    hideModal('result-modal');
    hideModal('rank-modal');
    clearInterval(this.timerId);

    this.status = 'idle';
    this.cash = INIT_CASH;
    this.shares = 0;
    this.cost = 0;
    this.timeLeft = GAME_DURATION;
    this.lastResult = null;
    this.market = new MarketEngine(INIT_PRICE);
    this.chart.curPrice = INIT_PRICE;
    this.chart.costPrice = null;
    this.chart.marks = [];
    this.chart.setData(this.market.bars);

    $('name-input').value = this.name;
    this.render();
    showModal('name-modal');
    $('name-input').focus();
    $('name-input').select();
  },

  /* ---------- 界面渲染 ---------- */
  render() {
    const price = this.market ? this.market.price : INIT_PRICE;
    const up = price >= INIT_PRICE;

    // 同步现价 / 成本价到图表（现价虚线、成本虚线）
    this.chart.curPrice = price;
    this.chart.costPrice = this.shares > 0 ? this.cost : null;

    $('top-price').textContent = price.toFixed(2);
    $('top-price').className = 'stock-price ' + (up ? 'up' : 'down');
    const chg = (price - INIT_PRICE) / INIT_PRICE * 100;
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

    // 按钮可用性（需预留手续费）
    const playing = this.status === 'playing';
    $('btn-buy10').disabled = !playing || this.cash < price * 10 * (1 + TRADE_FEE_RATE);
    $('btn-sell10').disabled = !playing || this.shares < 10;
    $('btn-allin').disabled = !playing || this.cash < price * (1 + TRADE_FEE_RATE);
    $('btn-clear').disabled = !playing || this.shares === 0;

    // 倒计时 + 进度条
    const left = Math.max(0, this.timeLeft);
    const m = Math.floor(left / 60), s = left % 60;
    const tEl = $('timer');
    tEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    tEl.className = 'timer' + (this.status === 'playing' && left <= 10 ? ' danger' : '');
    $('time-bar').style.width = (left / GAME_DURATION * 100) + '%';

    // 状态提示（中性，无播报）
    if (this.status === 'idle') $('chart-status').textContent = '等待开始…';
    else if (this.status === 'ended') $('chart-status').textContent = '游戏结束';
    else $('chart-status').textContent = '进行中';
  },
};

document.addEventListener('DOMContentLoaded', () => Game.init());
