/* ============================================================
 * market.js —— 庄家行情引擎（核心）
 *
 * K线的涨跌不是随机游走，而是由「庄家状态机」驱动，
 * 模拟真实股市中诱多、诱空、反复收割散户的经典场景：
 *
 *   - 散户小仓买入   → 拉涨诱多（目标 +20%），到点出货砸盘
 *   - 散户全仓买入   → 立刻砸盘收割
 *   - 拉升中散户卖出 → 洗盘抖一下继续拉（让你踏空）
 *   - 下跌中散户割肉 → 再小跌一下然后反弹（割在地板上）
 *   - 反弹中散户追买 → 继续跌（套牢陷阱）
 *
 * 状态机：normal(震荡) → pump(拉升) → dump(砸盘) → rebound(反弹) → ...
 * ============================================================ */
'use strict';

const PHASE = {
  NORMAL: 'normal',   // 正常震荡
  PUMP: 'pump',       // 诱多拉升
  DUMP: 'dump',       // 砸盘出货
  REBOUND: 'rebound', // 反弹
  SHAKE: 'shake',     // 洗盘抖动
};

class MarketEngine {
  constructor(basePrice = 100, historyBars = 36) {
    this.basePrice = basePrice;
    this.price = basePrice;
    this.phase = PHASE.NORMAL;
    this.phaseTime = 0;
    this.phaseOpts = {};   // { strength, duration, target, next }
    this.drift = 0;
    this.bars = [];
    this._genHistory(historyBars);
  }

  /* ---------- 工具：标准正态分布（Box-Muller） ---------- */
  _randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---------- 生成开局前的历史K线 ---------- */
  _genHistory(n) {
    let p = this.basePrice * 0.94;
    for (let i = 0; i < n; i++) {
      const open = p;
      const drift = 0.0012 * Math.sin(i / 5); // 温和的波浪
      const close = Math.max(1, open * (1 + drift + 0.012 * this._randn()));
      const high = Math.max(open, close) * (1 + Math.abs(this._randn()) * 0.009);
      const low = Math.min(open, close) * (1 - Math.abs(this._randn()) * 0.009);
      const volume = 1200 + Math.random() * 2200;
      this.bars.push({ open, high, low, close, volume, time: i });
      p = close;
    }
    this.price = p;
  }

  /* ---------- 状态切换 ---------- */
  _switch(phase, opts = {}) {
    this.phase = phase;
    this.phaseTime = 0;
    this.phaseOpts = opts;
  }

  /* ---------- 玩家行为 → 庄家反应 ---------- */
  onBuy(shares, allIn, cash, price) {
    const maxShares = Math.max(1, Math.floor(cash / price));
    const ratio = shares / maxShares;

    if (allIn || ratio >= 0.8) {
      // 重仓/全仓 → 立刻砸盘收割
      this._switch(PHASE.DUMP, {
        strength: 1.1 + Math.random() * 0.3,
        duration: 5 + Math.random() * 4,
      });
    } else if (this.phase === PHASE.REBOUND) {
      // 反弹中追买 → 套牢陷阱：继续跌
      this._switch(PHASE.DUMP, {
        strength: 0.9,
        duration: 4 + Math.random() * 3,
      });
    } else if (this.phase === PHASE.DUMP) {
      // 下跌中接飞刀 → 小反抽后再跌
      this._switch(PHASE.DUMP, {
        strength: 0.7,
        duration: 3 + Math.random() * 2,
      });
    } else if (this.phase === PHASE.PUMP) {
      // 拉升中追高 → 加速冲向目标价然后砸盘
      const target = Math.max(this.phaseOpts.target || this.price * 1.2, this.price * 1.05);
      this._switch(PHASE.PUMP, { target });
    } else {
      // 平时小买 → 诱多：拉涨到 +20%
      this._switch(PHASE.PUMP, { target: this.price * 1.2 });
    }
  }

  onSell(shares, allOut, holdingsBefore, price) {
    const ratio = holdingsBefore > 0 ? shares / holdingsBefore : 0;

    if (allOut || ratio >= 0.8) {
      // 清仓 / 大比例卖出
      if (this.phase === PHASE.DUMP) {
        // 割肉清仓 → 再小跌一下然后反弹（割在地板上）
        this._switch(PHASE.DUMP, {
          strength: 0.4,
          duration: 2 + Math.random() * 1.5,
          next: PHASE.REBOUND,
        });
      } else if (this.phase === PHASE.PUMP) {
        // 拉升中清仓 → 继续涨（踏空拍大腿）
        this._switch(PHASE.PUMP, {
          target: this.price * (1.08 + Math.random() * 0.1),
        });
      } else {
        // 其他情况清仓 → 行情回暖
        this._switch(PHASE.REBOUND, {
          duration: 3 + Math.random() * 2,
        });
      }
    } else {
      // 部分卖出
      if (this.phase === PHASE.PUMP) {
        // 拉升中卖出 → 洗盘抖一下，然后继续拉
        this._switch(PHASE.SHAKE, {
          duration: 2 + Math.random(),
          next: PHASE.PUMP,
        });
      } else if (this.phase === PHASE.DUMP) {
        // 下跌中卖出 → 反弹诱空（一卖就涨）
        this._switch(PHASE.REBOUND, {
          duration: 4 + Math.random() * 3,
        });
      }
    }
  }

  /* ---------- 每 tick 推进（1 秒 = 1 根K线，内部 12 个子步） ---------- */
  tick() {
    const steps = 12;
    const open = this.price;
    let high = open, low = open, close = open;
    let volume = 0;
    const baseVol = 1500;

    for (let i = 0; i < steps; i++) {
      this._stepPhase();
      close = Math.max(0.5, close * (1 + this.drift + this._noise()));
      high = Math.max(high, close);
      low = Math.min(low, close);

      // 随机影线（插针），让K线更真实
      if (Math.random() < 0.25) {
        const wick = close * (1 + (Math.random() - 0.5) * 0.012);
        high = Math.max(high, wick);
        low = Math.min(low, wick);
      }

      const ret = Math.abs(close - open) / open;
      volume += baseVol * (1 + ret * 40) * (this.phase === PHASE.DUMP ? 1.6 : 1) * (0.7 + Math.random() * 0.6);
    }

    this.price = close;
    this.bars.push({ open, high, low, close, volume, time: this.bars.length });

    // 拉升到达目标价（如 +20%）→ 出货砸盘
    if (this.phase === PHASE.PUMP && this.phaseOpts.target && close >= this.phaseOpts.target) {
      this._switch(PHASE.DUMP, {
        strength: 1.0,
        duration: 6 + Math.random() * 4,
      });
    }

    // 阶段超时 → 进入下一阶段（默认回到正常震荡）
    this.phaseTime++;
    const dur = this.phaseOpts.duration;
    if (dur && this.phaseTime >= dur) {
      const next = this.phaseOpts.next || PHASE.NORMAL;
      const opts = {};
      if (next === PHASE.PUMP && this.phaseOpts.target) opts.target = this.phaseOpts.target;
      if (next === PHASE.REBOUND) opts.duration = 3 + Math.random() * 2;
      this._switch(next, opts);
    }

    return this.bars[this.bars.length - 1];
  }

  /* ---------- 按当前阶段计算每步漂移 ---------- */
  _stepPhase() {
    const s = this.phaseOpts.strength ?? 1;
    switch (this.phase) {
      case PHASE.PUMP:
        this.drift = (0.0012 + Math.random() * 0.0012) * s;   // +0.12%~0.24% / 步 ≈ 1.5%~3% / 根
        break;
      case PHASE.DUMP:
        this.drift = -(0.0022 + Math.random() * 0.0022) * s;  // -0.22%~-0.44% / 步 ≈ 2.6%~5.3% / 根
        break;
      case PHASE.REBOUND:
        this.drift = (0.0010 + Math.random() * 0.0014) * s;
        break;
      case PHASE.SHAKE:
        this.drift = (Math.random() - 0.5) * 0.008;
        break;
      case PHASE.NORMAL:
      default:
        this.drift = (Math.random() - 0.5) * 0.004;
        break;
    }
  }

  _noise() {
    return this._randn() * 0.0015;
  }
}
