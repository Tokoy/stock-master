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

/* ============================================================
 * DamaiMarketEngine —— 大米科技：事件驱动妖股引擎（硬核模式）
 *
 * 与 SNK 的「操作触发庄家反应」不同，大米科技整局由三套系统驱动：
 *
 *  1. 隐藏剧本：开局随机抽一个剧本（吸筹拉升出货 / 连板天地板 /
 *     洗盘拉锯），整局按剧本推进；玩家买卖只产生 20~30% 的扰动，
 *     不再是一键触发开关，只能靠盘感。
 *
 *  2. 事件卡：局中随机触发 2~4 个新闻事件（真假掺杂），通过新闻栏
 *     滚动展示 + K线图事件标记。利好、利空、模棱两可、出货掩护…
 *
 *  3. 涨跌停：由重磅事件卡触发（被收购→涨停买不进；高层卷入案件/
 *     被外国针对→跌停卖不出），封板数根 K 线，流动性风险拉满。
 * ============================================================ */

/* ---------- 剧本库（drift 为每子步漂移，dur 为持续根数；走完进入尾声震荡，不循环） ---------- */
const DAMAI_SCRIPTS = [
  { // 剧本A：吸筹阴跌 → 利好拉升 → 出货砸盘
    name: '吸筹·拉升·出货',
    stages: [
      { drift: -0.0012, dur: 18 },  // 阴跌吸筹
      { drift:  0.0003, dur: 10 },  // 横盘磨人
      { drift:  0.0016, dur: 22 },  // 利好拉升
      { drift: -0.0022, dur: 18 },  // 出货砸盘
      { drift:  0.0008, dur: 12 },  // 尾声反抽
    ],
  },
  { // 剧本B：横盘等消息 → 连板 → 天地板
    name: '横盘·连板·天地板',
    stages: [
      { drift:  0.0003, dur: 14 },  // 横盘等消息
      { drift:  0.0040, dur: 3  },  // 首板
      { drift:  0.0030, dur: 6  },  // 连板
      { drift: -0.0055, dur: 6  },  // 天地板
      { drift: -0.0018, dur: 16 },  // 恐慌杀跌
      { drift:  0.0010, dur: 15 },  // 修复反抽
    ],
  },
  { // 剧本C：洗盘拉锯（最难读）
    name: '洗盘拉锯',
    stages: [
      { drift:  0.0016, dur: 8  },  // 试拉
      { drift: -0.0026, dur: 5  },  // 急跌洗盘
      { drift:  0.0014, dur: 8  },  // 再拉
      { drift: -0.0014, dur: 8  },  // 深蹲
      { drift:  0.0018, dur: 10 },  // 突破
      { drift: -0.0012, dur: 6  },  // 见顶回踩
      { drift:  0.0014, dur: 8  },  // 尾盘诱多
      { drift: -0.0022, dur: 7  },  // 收盘杀跌
    ],
  },
];

/* ---------- 事件卡池（真假掺杂） ---------- */
const DAMAI_EVENT_POOL = [
  // 真利好：连涨
  { type: 'good',     text: '大米科技发布会：新旗舰订单超预期',       emoji: '📢' },
  { type: 'good',     text: '大米科技财报亮眼，净利润同比大增',       emoji: '💰' },
  { type: 'good',     text: '大米科技拿下海外大额订单',               emoji: '🌍' },
  // 利空：下跌
  { type: 'bad',      text: '证监会向大米科技下发问询函',             emoji: '📄' },
  { type: 'bad',      text: '大米科技被曝供应商欠款纠纷',             emoji: '⚠️' },
  // 模棱两可：方向随机
  { type: 'ambiguous',text: '米总深夜发微博：「这次真的厚道」',        emoji: '🐦' },
  { type: 'ambiguous',text: '网传大米科技将发布神秘新品，官方不予置评', emoji: '🤫' },
  // 重磅·涨停：被收购
  { type: 'limitup',  text: '某巨头宣布溢价收购大米科技，明日复牌',   emoji: '🤝' },
  // 重磅·跌停：高层涉案 / 被外国针对
  { type: 'limitdown',text: '大米科技董事长卷入内幕交易案，被立案调查', emoji: '🚨' },
  { type: 'limitdown',text: '大米科技被列入外国实体清单',             emoji: '🌐' },
  // 出货掩护：先冲高再砸（利好是陷阱）
  { type: 'trap',     text: '大米科技斩获全球销量冠军，米总高调庆功', emoji: '🏆' },
  { type: 'trap',     text: '大米科技生态链大会圆满召开，现场火爆',   emoji: '🎉' },
];

class DamaiMarketEngine {
  constructor(basePrice = 50, duration = 90, historyBars = 36) {
    this.basePrice = basePrice;
    this.price = basePrice;
    this.duration = duration;
    this.bars = [];
    this.tickCount = 0;

    // 剧本
    this.script = DAMAI_SCRIPTS[Math.floor(Math.random() * DAMAI_SCRIPTS.length)];
    this.stageIdx = 0;
    this.stageTime = 0;

    // 玩家扰动（持续若干根K线，幅度为剧本漂移的 20~30%）
    this.playerDrift = 0;
    this.playerDriftLeft = 0;

    // 事件：pending 计划触发，eventQueue 临时覆盖剧本的阶段序列
    this.pendingEvents = [];   // { atTick, ev }
    this.events = [];          // 已触发 { type, text, emoji, barIndex, dir }
    this.eventQueue = [];      // [{ drift, dur }] 事件引发的临时阶段

    // 涨跌停封板
    this.limit = null;         // { dir: 'up'|'down', lockPrice, left }

    this.onEvent = null;       // 事件回调（Game 注入，用于新闻栏+图表标记）

    this._genHistory(historyBars);
    this._planEvents();
  }

  _randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  _genHistory(n) {
    let p = this.basePrice * 0.96;
    for (let i = 0; i < n; i++) {
      const open = p;
      const drift = 0.0016 * Math.sin(i / 4);
      const close = Math.max(1, open * (1 + drift + 0.016 * this._randn()));
      const high = Math.max(open, close) * (1 + Math.abs(this._randn()) * 0.011);
      const low = Math.min(open, close) * (1 - Math.abs(this._randn()) * 0.011);
      const volume = 1500 + Math.random() * 2600;
      this.bars.push({ open, high, low, close, volume, time: i });
      p = close;
    }
    this.price = p;
  }

  /* ---------- 事件计划：2~4 个，均匀散布在 8s~70s，重磅事件保底 ---------- */
  _planEvents() {
    const n = 2 + Math.floor(Math.random() * 3); // 2~4
    const slots = [];
    for (let i = 0; i < n; i++) {
      slots.push(8 + Math.floor(Math.random() * 62));
    }
    slots.sort((a, b) => a - b);
    // 间隔太近的事件推开，避免同屏触发
    for (let i = 1; i < slots.length; i++) {
      if (slots[i] - slots[i - 1] < 10) slots[i] = slots[i - 1] + 10;
    }

    const pool = DAMAI_EVENT_POOL.slice();
    const used = new Set();
    // 洗牌
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const pick = (pred) => {
      const idx = pool.findIndex((e, i) => pred(e) && !used.has(i));
      if (idx === -1) return null;
      used.add(idx);
      return pool[idx];
    };

    // 重磅事件（涨跌停/陷阱）每局最多一个，类型均衡三选一；
    // 其余事件只从利好/利空/模棱两可里抽，保证涨跌停的稀缺性。
    const heavyType = ['limitup', 'limitdown', 'trap'][Math.floor(Math.random() * 3)];
    const heavy = pick(e => e.type === heavyType) || pick(e => e.type === 'limitup' || e.type === 'limitdown' || e.type === 'trap');
    const events = heavy ? [heavy] : [];
    const isHeavy = (e) => e.type === 'limitup' || e.type === 'limitdown' || e.type === 'trap';
    for (let i = events.length; i < n; i++) {
      const e = pick(ev => !isHeavy(ev));
      if (!e) break;
      events.push(e);
    }

    this.pendingEvents = slots.map((atTick, i) => ({ atTick, ev: events[i % events.length] }));
  }

  /* ---------- 玩家行为 → 20~30% 扰动（不再一键触发） ---------- */
  onBuy(shares, allIn, cash, price) {
    const strength = (allIn ? 1.0 : Math.min(0.8, shares / Math.max(1, Math.floor(cash / price))));
    this.playerDrift = 0.0005 + strength * 0.0007;
    this.playerDriftLeft = 2 + Math.floor(Math.random() * 3);
  }

  onSell(shares, allOut, holdingsBefore, price) {
    const strength = (allOut ? 1.0 : Math.min(0.8, shares / Math.max(1, holdingsBefore)));
    this.playerDrift = -(0.0005 + strength * 0.0007);
    this.playerDriftLeft = 2 + Math.floor(Math.random() * 3);
  }

  /* ---------- 当前阶段漂移（含玩家扰动，幅度 ≈ 剧本的 20~30%） ---------- */
  _stageDrift() {
    let d = 0;
    if (this.eventQueue.length) {
      d = this.eventQueue[0].drift;
    } else if (this.stageIdx < this.script.stages.length) {
      d = this.script.stages[this.stageIdx].drift;
    } else {
      // 剧本走完 → 尾声震荡
      d = (Math.random() - 0.5) * 0.0012;
    }
    if (this.playerDriftLeft > 0) {
      this.playerDriftLeft--;
      d += this.playerDrift * (Math.random() * 0.6 + 0.7);
    }
    return d;
  }

  /* ---------- 事件触发 → 生效 ---------- */
  _fireEvent(ev, barIndex) {
    const dirs = ['up', 'down'];
    let dir = null;
    switch (ev.type) {
      case 'good':
        this.eventQueue.push({ drift: 0.0018, dur: 8 + Math.floor(Math.random() * 5) });
        dir = 'up';
        break;
      case 'bad':
        this.eventQueue.push({ drift: -0.0022, dur: 7 + Math.floor(Math.random() * 5) });
        dir = 'down';
        break;
      case 'ambiguous':
        dir = dirs[Math.floor(Math.random() * 2)];
        this.eventQueue.push({ drift: dir === 'up' ? 0.0016 : -0.0016, dur: 6 + Math.floor(Math.random() * 5) });
        break;
      case 'limitup':
        this.limit = { dir: 'up', lockPrice: this.price * 1.10, left: 3 + Math.floor(Math.random() * 4) };
        dir = 'up';
        break;
      case 'limitdown':
        this.limit = { dir: 'down', lockPrice: this.price * 0.90, left: 3 + Math.floor(Math.random() * 4) };
        dir = 'down';
        break;
      case 'trap':
        // 先冲高（出货掩护），随后立刻转砸
        this.eventQueue.push({ drift: 0.0035, dur: 5 });
        this.eventQueue.push({ drift: -0.0028, dur: 10 });
        dir = 'up';
        break;
    }
    const rec = { type: ev.type, text: ev.text, emoji: ev.emoji, barIndex, dir };
    this.events.push(rec);
    if (this.onEvent) this.onEvent(rec);
  }

  /* ---------- 每 tick 推进（1 秒 = 1 根K线，内部 12 子步） ---------- */
  tick() {
    this.tickCount++;
    let open = this.price;
    let high = open, low = open, close = open;
    let volume = 0;
    const baseVol = 1800;

    // 到点触发事件
    while (this.pendingEvents.length && this.pendingEvents[0].atTick <= this.tickCount) {
      this._fireEvent(this.pendingEvents.shift().ev, this.bars.length);
    }

    // 涨跌停封板：一字板钉死，买不进/卖不出
    if (this.limit) {
      const lp = this.limit.lockPrice;
      open = lp;
      close = lp;
      high = lp * 1.001;
      low = lp * 0.999;
      volume = baseVol * (4 + Math.random() * 3); // 封板巨量
      this.limit.left--;
      if (this.limit.left <= 0) this.limit = null; // 开板
    } else {
      const steps = 12;
      for (let i = 0; i < steps; i++) {
        const drift = this._stageDrift();
        close = Math.max(0.5, close * (1 + drift + this._randn() * 0.0022));
        high = Math.max(high, close);
        low = Math.min(low, close);
        if (Math.random() < 0.25) {
          const wick = close * (1 + (Math.random() - 0.5) * 0.014);
          high = Math.max(high, wick);
          low = Math.min(low, wick);
        }
      }
      const ret = Math.abs(close - open) / open;
      volume = baseVol * (1 + ret * 40) * (0.7 + Math.random() * 0.6);
    }

    this.price = close;
    this.bars.push({ open, high, low, close, volume, time: this.bars.length });

    // 剧本/事件阶段推进（封板期间暂停，开板后继续；剧本走完进入尾声不再循环）
    if (!this.limit) {
      this.stageTime++;
      if (this.eventQueue.length) {
        this.eventQueue[0].dur--;
        if (this.eventQueue[0].dur <= 0) this.eventQueue.shift();
      } else if (this.stageIdx < this.script.stages.length) {
        const cur = this.script.stages[this.stageIdx];
        if (this.stageTime >= cur.dur) {
          this.stageIdx++;
          this.stageTime = 0;
        }
      }
    }

    return this.bars[this.bars.length - 1];
  }
}
